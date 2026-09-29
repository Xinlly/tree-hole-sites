import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = await mkdtemp(path.join(os.tmpdir(), "store-factory-"));
const SQL_DB_PATH = path.join(tmp, "factory.db");

const OBJECT_VARS = {
  STORAGE_OBJECT_ENDPOINT: "https://example.test",
  STORAGE_OBJECT_REGION: "us-east-1",
  STORAGE_OBJECT_BUCKET: "test-bucket",
  STORAGE_OBJECT_ACCESS_KEY_ID: "test-access-key",
  STORAGE_OBJECT_SECRET_ACCESS_KEY: "test-secret-key",
};

function clearObjectVars() {
  for (const name of Object.keys(OBJECT_VARS)) {
    delete process.env[name];
  }
}

test.after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// 惰性单例缓存在模块内，每个用例用唯一 query 取一份全新模块副本
async function freshFactory(tag) {
  return import(`../app/api/store/index.ts?t=${tag}`);
}

test("default and STORAGE_TYPE=sql produce a SqlStore", async () => {
  clearObjectVars();
  delete process.env.STORAGE_TYPE;
  process.env.TREE_HOLE_DB_PATH = SQL_DB_PATH;

  const def = await freshFactory("default");
  const defaultStore = def.getStore();
  assert.equal(defaultStore.constructor.name, "SqlStore");
  assert.equal(def.getStore(), defaultStore); // 惰性单例

  process.env.STORAGE_TYPE = "sql";
  const sql = await freshFactory("sql");
  assert.equal(sql.getStore().constructor.name, "SqlStore");
});

test("STORAGE_TYPE=object produces an ObjectStore", async () => {
  process.env.STORAGE_TYPE = "object";
  Object.assign(process.env, OBJECT_VARS);

  const obj = await freshFactory("object");
  const store = obj.getStore();
  assert.equal(store.constructor.name, "ObjectStore");
  assert.equal(obj.getStore(), store);
});

test("invalid STORAGE_TYPE throws without silent fallback", async () => {
  process.env.STORAGE_TYPE = "mysql";
  Object.assign(process.env, OBJECT_VARS);

  const bad = await freshFactory("invalid");
  assert.throws(
    () => bad.getStore(),
    /^Error: Invalid STORAGE_TYPE "mysql" \(expected sql\|object\)$/,
  );
});

test("object type with missing OBJECT_* vars throws", async () => {
  process.env.STORAGE_TYPE = "object";
  clearObjectVars();

  const broken = await freshFactory("missing");
  assert.throws(
    () => broken.getStore(),
    /^Error: Missing object storage config: STORAGE_OBJECT_/,
  );

  // 缺单个变量也报错（不静默回退到 sql）
  Object.assign(process.env, OBJECT_VARS);
  delete process.env.STORAGE_OBJECT_BUCKET;
  assert.throws(
    () => broken.getStore(),
    /Missing object storage config: STORAGE_OBJECT_BUCKET/,
  );
});
