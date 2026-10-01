#!/usr/bin/env node
// 停机态一次性迁移：旧根对象（整 JSON）-> v2/ 分块布局的 state（§9）。
// 停机态可重跑（覆盖写、幂等）；不删旧对象。切流后不得再重跑（ULID 随机段会变）。
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { monotonicFactory } from "ulid";

const REQUIRED = [
  "STORAGE_OBJECT_ENDPOINT",
  "STORAGE_OBJECT_REGION",
  "STORAGE_OBJECT_BUCKET",
  "STORAGE_OBJECT_ACCESS_KEY_ID",
  "STORAGE_OBJECT_SECRET_ACCESS_KEY",
];

const COLLECTIONS = [
  {
    name: "messages",
    legacyKey: "visitor-messages.json",
    map: (row, id) => ({
      id,
      nickname: row.nickname,
      content: row.content,
      createdAt: row.createdAt,
    }),
  },
  {
    name: "entries",
    legacyKey: "tree-hole-entries.json",
    map: (row, id) => ({
      id,
      mood: row.mood,
      content: row.content,
      reply: row.reply,
      createdAt: row.createdAt,
    }),
  },
];

function parseLegacyCreatedAt(value) {
  // 旧 createdAt 为秒级字符串 "YYYY-MM-DD HH:MM:SS"（UTC）
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`unrecognized createdAt "${value}"`);
  }
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
}

function buildActive(legacyItems, mapRow) {
  const newId = monotonicFactory();
  // 旧 items 为旧→新；同秒按原数组顺序 monotonic 生成 ULID
  const oldToNew = legacyItems.map((row) => {
    if (typeof row.createdAt !== "string") {
      throw new Error("legacy item missing string createdAt");
    }
    const id = newId(parseLegacyCreatedAt(row.createdAt));
    return mapRow(row, id);
  });
  // active 规定新在前：reverse 后放入
  return oldToNew.reverse();
}

function verify(active, legacyItems) {
  if (active.length !== legacyItems.length) {
    throw new Error("verify failed: item count mismatch");
  }
  for (let i = 0; i < active.length; i += 1) {
    // active 新在前，legacy 旧→新；反向对应
    const legacy = legacyItems[legacyItems.length - 1 - i];
    const item = active[i];
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(item.id)) {
      throw new Error("verify failed: id not replaced by ULID");
    }
    if (item.id === legacy.id) {
      throw new Error("verify failed: old numeric id retained");
    }
    for (const key of Object.keys(legacy)) {
      if (key === "id") continue;
      if (item[key] !== legacy[key]) {
        throw new Error(`verify failed: field "${key}" changed`);
      }
    }
  }
}

async function readLegacy(client, bucket, key) {
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const text = await bodyToString(response.Body);
    const data = JSON.parse(text);
    if (!Array.isArray(data.items)) {
      throw new Error(`legacy object ${key} missing items array`);
    }
    return data.items;
  } catch (error) {
    if (error?.name === "NoSuchKey" || error?.Code === "NoSuchKey") {
      return [];
    }
    throw error;
  }
}

async function bodyToString(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (typeof body.transformToString === "function") {
    return body.transformToString();
  }
  throw new Error("unsupported legacy object body");
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

async function migrateCollection(client, bucket, collection) {
  const legacyItems = await readLegacy(client, bucket, collection.legacyKey);
  if (legacyItems.length > 20) {
    // §9 前提：当前 2 留言 + 3 封存均 <20；超出则设计未覆盖，停下上报
    throw new Error(
      `${collection.name}: ${legacyItems.length} items > 20, block layout not covered by §9`,
    );
  }
  const active = buildActive(legacyItems, collection.map);
  verify(active, legacyItems);

  const tombstonesKey = `v2/${collection.name}/tombstones.json.gz`;
  const stateKey = `v2/${collection.name}/state.json.gz`;
  // 先 PUT tombstones（空数组），后 PUT state
  await putGz(client, bucket, tombstonesKey, []);
  await putGz(client, bucket, stateKey, {
    version: 2,
    active,
    headBlockKey: null,
    tombstonesKey,
    updatedAt: Date.now(),
  });
  return legacyItems.length;
}

async function main() {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing object storage config: ${missing.join(", ")}`);
  }

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

  const bucket = process.env.STORAGE_OBJECT_BUCKET;
  const counts = [];
  for (const collection of COLLECTIONS) {
    counts.push(`${collection.name}=${await migrateCollection(client, bucket, collection)}`);
  }
  console.log(`legacy -> v2 migrated: ${counts.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
