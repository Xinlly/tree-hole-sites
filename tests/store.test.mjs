import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = await mkdtemp(path.join(os.tmpdir(), "tree-hole-store-"));
process.env.TREE_HOLE_DB_PATH = path.join(tmp, "test.db");
const PUBLIC = { kind: "public", id: "" };
const store = await import("../app/api/tree-hole-store.ts");

test.after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("messages: create, list and delete through real SQLite", async () => {
  await store.createMessage(PUBLIC, "小明", "今天也要开心");
  await store.createMessage(PUBLIC, "阿珍", "把秘密放进树洞");

  const messages = await store.listMessages(PUBLIC);
  assert.equal(messages.items.length, 2);
  assert.equal(messages.items[0].nickname, "阿珍");
  assert.equal(messages.items[0].content, "把秘密放进树洞");
  assert.ok(messages.items[0].createdAt);
  assert.equal(messages.items[0].scopeKind, "public");
  assert.equal(messages.items[0].scopeId, "");
  assert.equal(messages.items[0].locked, false);
  assert.equal(messages.items[1].nickname, "小明");

  await store.deleteMessage(PUBLIC, messages.items[0].id);
  const remaining = await store.listMessages(PUBLIC);
  assert.equal(remaining.items.length, 1);
  assert.equal(remaining.items[0].nickname, "小明");
});

test("entries: create keeps Chinese text, delete removes row", async () => {
  await store.createEntry(PUBLIC, "开心", "考上了理想的学校");
  const entries = await store.listEntries(PUBLIC);
  assert.equal(entries.items.length, 1);
  assert.equal(entries.items[0].mood, "开心");
  assert.equal(entries.items[0].content, "考上了理想的学校");
  // 创建一律 reply=""，回复走 reply 路由
  assert.equal(entries.items[0].reply, "");
  assert.ok(entries.items[0].createdAt);
  assert.equal(entries.items[0].locked, false);

  await store.deleteEntry(PUBLIC, entries.items[0].id);
  assert.deepEqual((await store.listEntries(PUBLIC, { limit: 20 })).items, []);
});

test("normalizeNickname trims, caps length and falls back to 匿名", () => {
  assert.equal(store.normalizeNickname("  树洞居民  "), "树洞居民");
  assert.equal(store.normalizeNickname("a".repeat(30)), "a".repeat(24));
  assert.equal(store.normalizeNickname("   "), "匿名");
  assert.equal(store.normalizeNickname(undefined), "匿名");
});

test("toErrorMessage handles Error and non-Error values", () => {
  assert.equal(store.toErrorMessage(new Error("boom")), "boom");
  assert.equal(store.toErrorMessage("string"), "Unexpected error");
});
