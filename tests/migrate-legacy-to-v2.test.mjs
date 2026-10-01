import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const BUCKET = "test-bucket";
const PORT = 47999;

const LEGACY = {
  "visitor-messages.json": {
    nextId: 5,
    items: [
      { id: 1, nickname: "小明", content: "第一条留言", createdAt: "2026-09-01 10:00:00" },
      { id: 2, nickname: "阿珍", content: "第二条留言😊", createdAt: "2026-09-02 10:00:00" },
      { id: 3, nickname: "同秒", content: "同秒较早", createdAt: "2026-09-03 05:00:00" },
      { id: 4, nickname: "同秒", content: "同秒较晚", createdAt: "2026-09-03 05:00:00" },
    ],
  },
  "tree-hole-entries.json": {
    nextId: 2,
    items: [
      { id: 1, mood: "开心", content: "封存一", reply: "回复一", createdAt: "2026-09-01 08:00:00" },
    ],
  },
};

function startFakeS3() {
  const store = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const key = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length));
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.method === "GET") {
        if (store.has(key)) {
          res.statusCode = 200;
          res.end(store.get(key));
        } else if (key in LEGACY) {
          res.statusCode = 200;
          res.end(Buffer.from(JSON.stringify(LEGACY[key]), "utf8"));
        } else {
          res.statusCode = 404;
          res.setHeader("content-type", "application/xml");
          res.end("<Error><Code>NoSuchKey</Code></Error>");
        }
        return;
      }
      if (req.method === "PUT") {
        store.set(key, body);
        res.statusCode = 200;
        res.end();
        return;
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
      ["scripts/migrate-legacy-to-v2.mjs"],
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

function readGz(store, key) {
  return JSON.parse(new TextDecoder().decode(gunzipSync(store.get(key))));
}

test("F1: legacy objects migrate to v2 state; field-faithful, ordered, idempotent, legacy kept", async () => {
  const { server, store } = await startFakeS3();
  try {
    const log = await runMigration();
    assert.match(log, /messages=4/);
    assert.match(log, /entries=1/);

    const tombstones = readGz(store, "v2/messages/tombstones.json.gz");
    assert.deepEqual(tombstones, []);
    const state = readGz(store, "v2/messages/state.json.gz");
    assert.equal(state.version, 2);
    assert.equal(state.headBlockKey, null);
    assert.equal(state.active.length, 4);

    // 新在前；同秒两条保持旧数组顺序（较晚在后→新，排前）
    assert.deepEqual(state.active.map((m) => m.content), [
      "同秒较晚", "同秒较早", "第二条留言😊", "第一条留言",
    ]);
    for (const item of state.active) {
      assert.match(item.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
    // 字段保真（除 id 换成 ULID）
    assert.deepEqual(
      { ...state.active[3], id: undefined },
      { id: undefined, nickname: "小明", content: "第一条留言", createdAt: "2026-09-01 10:00:00" },
    );

    const entryState = readGz(store, "v2/entries/state.json.gz");
    assert.equal(entryState.active[0].mood, "开心");
    assert.equal(entryState.active[0].reply, "回复一");

    // 旧对象保留：脚本不含 DeleteObject；fake 对 DELETE 返回 405，
    // 迁移成功即证明未发删除请求（旧对象由 LEGACY 常量只读提供）。
    const firstContents = state.active.map((m) => m.content);
    await runMigration();
    const state2 = readGz(store, "v2/messages/state.json.gz");
    assert.deepEqual(state2.active.map((m) => m.content), firstContents);
  } finally {
    server.close();
  }
});
