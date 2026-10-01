import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const BUCKET = "test-bucket";
const PORT = 47998;
const MARKER = "v3/public/migration-v2-to-v3.done.json.gz";

// —— v2 种子数据（旧形状：无 scope/locked）——
const m1 = { id: "01M1OLD0000000000000000001", nickname: "小明", content: "块内旧1", createdAt: "2026-09-01 10:00:00" };
const m2 = { id: "01M1OLD0000000000000000002", nickname: "阿珍", content: "块内旧2", createdAt: "2026-09-02 10:00:00" };
const m3 = { id: "01M1OLD0000000000000000003", nickname: "阿强", content: "活动旧3", createdAt: "2026-09-03 10:00:00" };
const m4 = { id: "01M1OLD0000000000000000004", nickname: "匿名", content: "活动旧4", createdAt: "2026-09-04 10:00:00" };

const e1 = { id: "01E1OLD0000000000000000001", mood: "开心", content: "封存心事", reply: "管理员回复", createdAt: "2026-09-01 08:00:00" };

function gz(value) {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
}

// 返回一个预播种 v2 的假 S3（支持 GET 取对象 / GET list-type=2 列举 / PUT）
function startFakeS3() {
  const store = new Map();
  const put = (key, value) => store.set(key, gz(value));

  // messages：1 个封存块 + 2 条 active + 1 条墓碑
  put("v2/messages/blocks/AAA.json.gz", { id: "AAA", items: [m1, m2] });
  put("v2/messages/tombstones.json.gz", ["DELETED-ID-X"]);
  put("v2/messages/state.json.gz", {
    version: 2,
    active: [m4, m3], // 新在前
    headBlockKey: "v2/messages/blocks/AAA.json.gz",
    tombstonesKey: "v2/messages/tombstones.json.gz",
    updatedAt: 1759000000000,
  });
  // entries：1 条 active，无块
  put("v2/entries/tombstones.json.gz", []);
  put("v2/entries/state.json.gz", {
    version: 2,
    active: [e1],
    headBlockKey: null,
    tombstonesKey: "v2/entries/tombstones.json.gz",
    updatedAt: 1759000000000,
  });

  const listXml = (prefix) => {
    const keys = [...store.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();
    const contents = keys
      .map((k) => `<Contents><Key>${k}</Key></Contents>`)
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${contents}</ListBucketResult>`;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      // ListObjectsV2
      if (url.searchParams.get("list-type") === "2") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/xml");
        return res.end(listXml(url.searchParams.get("prefix") ?? ""));
      }
      const key = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length));
      if (req.method === "GET") {
        if (store.has(key)) {
          res.statusCode = 200;
          return res.end(store.get(key));
        }
        res.statusCode = 404;
        res.setHeader("content-type", "application/xml");
        return res.end("<Error><Code>NoSuchKey</Code></Error>");
      }
      if (req.method === "PUT") {
        store.set(key, Buffer.concat(chunks));
        res.statusCode = 200;
        return res.end();
      }
      res.statusCode = 405;
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(PORT, "127.0.0.1", () => resolve({ server, store }));
  });
}

function runMigration() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/migrate-v2-to-v3-public.mjs"],
      {
        cwd: root,
        env: {
          ...process.env,
          STORAGE_OBJECT_ENDPOINT: `http://127.0.0.1:${PORT}`,
          STORAGE_OBJECT_REGION: "us-east-1",
          STORAGE_OBJECT_BUCKET: BUCKET,
          STORAGE_OBJECT_ACCESS_KEY_ID: "a",
          STORAGE_OBJECT_SECRET_ACCESS_KEY: "b",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
  });
}

const readGz = (store, key) =>
  JSON.parse(new TextDecoder().decode(gunzipSync(store.get(key))));

test("M1: v2 chunked layout migrates to v3/public; fields/order kept, refs rewritten, v2 kept", async () => {
  const { server, store } = await startFakeS3();
  try {
    const log = await runMigration();
    assert.match(log, /messages=2/);
    assert.match(log, /entries=1/);

    // —— messages state ——
    const state = readGz(store, "v3/public/messages/state.json.gz");
    assert.equal(state.version, 3);
    assert.equal(state.active.length, 2);
    assert.deepEqual(state.active.map((m) => m.content), ["活动旧4", "活动旧3"]); // 顺序保持
    assert.equal(state.headBlockKey, "v3/public/messages/blocks/AAA.json.gz");
    assert.equal(state.tombstonesKey, "v3/public/messages/tombstones.json.gz");
    for (const m of state.active) {
      assert.equal(m.scopeKind, "public");
      assert.equal(m.scopeId, "");
      assert.equal(m.locked, false);
    }
    // 字段保真（旧字段原样保留）
    assert.equal(state.active[0].id, m4.id);
    assert.equal(state.active[0].createdAt, m4.createdAt);

    // —— 封存块搬迁并注入字段 ——
    const block = readGz(store, "v3/public/messages/blocks/AAA.json.gz");
    assert.equal(block.id, "AAA");
    assert.deepEqual(block.items.map((m) => m.content), ["块内旧1", "块内旧2"]);
    for (const m of block.items) {
      assert.equal(m.scopeKind, "public");
      assert.equal(m.scopeId, "");
      assert.equal(m.locked, false);
    }

    // —— 墓碑原样搬迁（防复活）——
    assert.deepEqual(readGz(store, "v3/public/messages/tombstones.json.gz"), ["DELETED-ID-X"]);

    // —— entries：reply 保留 + 注入 scope ——
    const es = readGz(store, "v3/public/entries/state.json.gz");
    assert.equal(es.version, 3);
    assert.equal(es.active[0].reply, "管理员回复");
    assert.equal(es.active[0].scopeKind, "public");
    assert.equal(es.active[0].locked, false);
    assert.equal(es.headBlockKey, null);

    // —— 完成标记 ——
    assert.ok(store.has(MARKER));

    // —— 旧 v2 一律保留（脚本不发 DELETE；假服务器 DELETE 也返回 405）——
    assert.ok(store.has("v2/messages/state.json.gz"));
    assert.ok(store.has("v2/messages/blocks/AAA.json.gz"));
  } finally {
    server.close();
  }
});

test("M2: rerun with marker skips entirely (idempotent)", async () => {
  const { server, store } = await startFakeS3();
  try {
    await runMigration();
    const before = store.get("v3/public/messages/state.json.gz");
    const log = await runMigration();
    assert.match(log, /marker exists; skipping/);
    // state 未被重写
    assert.deepEqual(store.get("v3/public/messages/state.json.gz"), before);
  } finally {
    server.close();
  }
});

test("M3: missing v2 collections seed empty v3/public containers and still write marker", async () => {
  const store = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (url.searchParams.get("list-type") === "2") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/xml");
        return res.end("<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"></ListBucketResult>");
      }
      const key = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length));
      if (req.method === "GET") {
        if (store.has(key)) {
          res.statusCode = 200;
          return res.end(store.get(key));
        }
        res.statusCode = 404;
        res.setHeader("content-type", "application/xml");
        return res.end("<Error><Code>NoSuchKey</Code></Error>");
      }
      if (req.method === "PUT") {
        store.set(key, Buffer.concat(chunks));
        res.statusCode = 200;
        return res.end();
      }
      res.statusCode = 405;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  try {
    const log = await runMigration();
    assert.match(log, /messages=0/);
    assert.match(log, /entries=0/);
    assert.ok(store.has("v3/public/messages/state.json.gz"));
    assert.ok(store.has("v3/public/entries/state.json.gz"));
    assert.ok(store.has(MARKER));
    assert.equal(readGz(store, "v3/public/messages/state.json.gz").version, 3);
  } finally {
    server.close();
  }
});
