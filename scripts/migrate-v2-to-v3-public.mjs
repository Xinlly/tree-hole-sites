#!/usr/bin/env node
// 停机态一次性迁移：v2 分块布局 -> v3/public 空间（§5.2）。
// 给每条留言/封存补 scopeKind="public"/scopeId=""/locked=false；
// 块与墓碑一并搬迁，state 内 headBlockKey/tombstonesKey 引用改写为 v3/public；
// state.version=3；完成标记存在即整体跳过（可安全重跑）；旧 v2 一律不删。
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { gunzipSync, gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";

const REQUIRED = [
  "STORAGE_OBJECT_ENDPOINT",
  "STORAGE_OBJECT_REGION",
  "STORAGE_OBJECT_BUCKET",
  "STORAGE_OBJECT_ACCESS_KEY_ID",
  "STORAGE_OBJECT_SECRET_ACCESS_KEY",
];

const COLLECTIONS = ["messages", "entries"];
const V2_VERSION = 2;
const V3_VERSION = 3;
const MARKER_KEY = "v3/public/migration-v2-to-v3.done.json.gz";

// 公共空间字段注入（位置不变，仅追加/覆盖）
function toPublic(item) {
  return {
    ...item,
    scopeKind: "public",
    scopeId: "",
    locked: false,
  };
}

function v3Key(v2KeyName) {
  return v2KeyName.replace(/^v2\//, "v3/public/");
}

async function migrateCollection(client, bucket, name) {
  const stateKeyName = `v2/${name}/state.json.gz`;
  let state;
  try {
    state = JSON.parse(await getObject(client, bucket, stateKeyName));
  } catch (error) {
    if (isNoSuchKey(error)) {
      // v2 无该集合：写一个空 v3 容器，保证迁移后布局确定
      const tombstonesKeyName = `v3/public/${name}/tombstones.json.gz`;
      await putGz(client, bucket, tombstonesKeyName, []);
      await putGz(client, bucket, `v3/public/${name}/state.json.gz`, {
        version: V3_VERSION,
        active: [],
        headBlockKey: null,
        tombstonesKey: tombstonesKeyName,
        updatedAt: Date.now(),
      });
      return 0;
    }
    throw error;
  }

  if (
    state.version !== V2_VERSION ||
    !Array.isArray(state.active) ||
    typeof state.tombstonesKey !== "string" ||
    !(state.headBlockKey === null || typeof state.headBlockKey === "string")
  ) {
    throw new Error(`unexpected v2 state in ${stateKeyName}`);
  }

  // 1) 搬块（LIST 全块，含孤儿块）：项注入公共字段，键改写为 v3/public
  const list = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `v2/${name}/blocks/`,
      MaxKeys: 1000,
    }),
  );
  for (const entry of list.Contents ?? []) {
    const oldBlockKey = entry.Key;
    if (!oldBlockKey) continue;
    const block = JSON.parse(await getObject(client, bucket, oldBlockKey));
    if (typeof block.id !== "string" || !Array.isArray(block.items)) {
      throw new Error(`invalid v2 block in ${oldBlockKey}`);
    }
    await putGz(client, bucket, v3Key(oldBlockKey), {
      id: block.id,
      items: block.items.map(toPublic),
    });
  }

  // 2) 搬墓碑（原样保留 id，防已删项复活）
  const tombstones = JSON.parse(
    await getObject(client, bucket, state.tombstonesKey),
  );
  if (!Array.isArray(tombstones)) {
    throw new Error(`invalid v2 tombstones in ${state.tombstonesKey}`);
  }
  const newTombstonesKey = v3Key(state.tombstonesKey);
  await putGz(client, bucket, newTombstonesKey, tombstones);

  // 3) 写 state：active 注入字段，块/墓碑引用改写，version=3
  const newState = {
    version: V3_VERSION,
    active: state.active.map(toPublic),
    headBlockKey: state.headBlockKey ? v3Key(state.headBlockKey) : null,
    tombstonesKey: newTombstonesKey,
    updatedAt: Date.now(),
  };
  await putGz(client, bucket, `v3/public/${name}/state.json.gz`, newState);

  return newState.active.length;
}

async function getObject(client, bucket, key) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return readBody(response.Body);
}

function putGz(client, bucket, key, value) {
  return client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: gzipSync(Buffer.from(JSON.stringify(value), "utf8")),
      ContentType: "application/gzip",
    }),
  );
}

async function readBody(body) {
  if (body == null) return "";
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(gunzipSync(body));
  }
  if (typeof body === "string") {
    return new TextDecoder().decode(gunzipSync(Buffer.from(body, "binary")));
  }
  const stream = body;
  // gzip 按字节读（§5）
  if (typeof stream.transformToByteArray === "function") {
    const bytes = await stream.transformToByteArray();
    return new TextDecoder().decode(gunzipSync(Buffer.from(bytes)));
  }
  if (typeof stream.transformToString === "function") {
    const text = await stream.transformToString("binary");
    return new TextDecoder().decode(gunzipSync(Buffer.from(text, "binary")));
  }
  throw new Error("Unsupported S3 object body");
}

function isNoSuchKey(error) {
  const target = error ?? null;
  return target?.name === "NoSuchKey" || target?.Code === "NoSuchKey";
}

async function main() {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing object storage config: ${missing.join(", ")}`);
  }

  const bucket = process.env.STORAGE_OBJECT_BUCKET;
  const client = new S3Client({
    region: process.env.STORAGE_OBJECT_REGION,
    endpoint: process.env.STORAGE_OBJECT_ENDPOINT,
    credentials: {
      accessKeyId: process.env.STORAGE_OBJECT_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_OBJECT_SECRET_ACCESS_KEY,
    },
    requestHandler: new NodeHttpHandler({
      requestTimeout: 5000,
      connectionTimeout: 3000,
    }),
  });

  // 完成标记：存在即整体跳过（可安全重跑）
  try {
    await getObject(client, bucket, MARKER_KEY);
    console.log("migration marker exists; skipping v2 -> v3/public migration");
    return;
  } catch (error) {
    if (!isNoSuchKey(error)) throw error;
  }

  const counts = [];
  for (const name of COLLECTIONS) {
    counts.push(`${name}=${await migrateCollection(client, bucket, name)}`);
  }

  // 全部成功后才落完成标记
  await putGz(client, bucket, MARKER_KEY, {
    version: V3_VERSION,
    migratedAt: new Date().toISOString(),
  });
  console.log(`v2 -> v3/public migrated: ${counts.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
