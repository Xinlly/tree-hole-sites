import assert from "node:assert/strict";
import test from "node:test";
import { resetBucket } from "./_helpers/harness.mjs";
import { decodeCursor } from "../app/api/store/cursor.ts";
import {
  LockedError,
  NotFoundError,
} from "../app/api/store/types.ts";
import { ObjectStore } from "../app/api/store/object-store.ts";

function makeStore() {
  return new ObjectStore();
}

const PUBLIC = { kind: "public", id: "" };

// —— A11：分页（三类空间×两集合） ——

test("A11 messages: 45 条翻 3 页，顺序/无重复/无漏条/v3 cursor 可解码", async () => {
  resetBucket();
  const store = makeStore();
  await store.ensureInitialized();
  for (let i = 0; i < 45; i += 1) {
    await store.createMessage(PUBLIC, "u", `m${i + 1}`);
    await new Promise((r) => setTimeout(r, 1));
  }

  const all = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 4; page += 1) {
    const opts = { limit: 20 };
    if (cursor) {
      const decoded = decodeCursor(cursor);
      opts.afterId = decoded.afterId;
      opts.blockKey = decoded.blockKey;
      opts.index = decoded.index;
    }
    const res = await store.listMessages(PUBLIC, opts);
    for (const item of res.items) {
      assert.equal(seen.has(item.id), false, `重复 ${item.id}`);
      seen.add(item.id);
      all.push(item);
    }
    if (!res.hasMore) {
      assert.equal(res.nextCursor, null);
      break;
    }
    cursor = res.nextCursor;
  }
  assert.equal(all.length, 45);
  // 顺序：内容 m45..m1（新→旧）
  all.forEach((item, i) => assert.equal(item.content, `m${45 - i}`));
});

test("A11 entries: 23 条翻页无重复漏条", async () => {
  resetBucket();
  const store = makeStore();
  await store.ensureInitialized();
  for (let i = 0; i < 23; i += 1) {
    await store.createEntry(PUBLIC, "心情", `e${i + 1}`);
    await new Promise((r) => setTimeout(r, 1));
  }
  const ids = new Set();
  let cursor = null;
  let total = 0;
  for (let p = 0; p < 3; p += 1) {
    const opts = { limit: 20 };
    if (cursor) {
      const d = decodeCursor(cursor);
      Object.assign(opts, d);
    }
    const res = await store.listEntries(PUBLIC, opts);
    for (const it of res.items) {
      assert.ok(!ids.has(it.id));
      ids.add(it.id);
      total += 1;
    }
    if (!res.hasMore) break;
    cursor = res.nextCursor;
  }
  assert.equal(total, 23);
});

test("A11 pass 空间: 21 条翻页 + cursor 块键带本空间前缀", async () => {
  resetBucket();
  const store = makeStore();
  const scope = { kind: "pass", id: "a".repeat(64) };
  await store.ensureInitialized();
  for (let i = 0; i < 21; i += 1) {
    await store.createMessage(scope, "u", `p${i}`);
    await new Promise((r) => setTimeout(r, 1));
  }
  const page1 = await store.listMessages(scope, { limit: 20 });
  assert.equal(page1.items.length, 20);
  assert.ok(page1.hasMore);
  const decoded = decodeCursor(page1.nextCursor);
  // 封存块提示键属于本空间
  assert.ok(decoded.blockKey?.startsWith(`v3/pass/${scope.id}/`));
  const page2 = await store.listMessages(scope, {
    limit: 20,
    afterId: decoded.afterId,
    blockKey: decoded.blockKey,
    index: decoded.index,
  });
  assert.equal(page2.items.length, 1);
});

test("A11 user 空间: 分页 cursor 块键带 user 前缀，跨空间游标被拒", async () => {
  resetBucket();
  const store = makeStore();
  const uid = "01M3VRJR0PB6ZSQD9H3ZNSBMBP";
  const scope = { kind: "user", id: uid };
  await store.ensureInitialized();
  for (let i = 0; i < 21; i += 1) {
    await store.createEntry(scope, "mood", `u${i}`);
    await new Promise((r) => setTimeout(r, 1));
  }
  const page1 = await store.listEntries(scope, { limit: 20 });
  const decoded = decodeCursor(page1.nextCursor);
  assert.ok(decoded.blockKey?.startsWith(`v3/user/${uid}/`));

  // 拿 pass 空间的块键游标在 user 空间使用 → 抛错
  const passKey = `v3/pass/${"b".repeat(64)}/entries/blocks/${"C".repeat(26)}.json.gz`;
  const evilCursor = Buffer.from(
    JSON.stringify({ afterId: decoded.afterId, blockKey: passKey, index: 0 }),
  ).toString("base64url");
  const evil = decodeCursor(evilCursor);
  await assert.rejects(
    store.listEntries(scope, {
      limit: 20,
      afterId: evil.afterId,
      blockKey: evil.blockKey,
      index: evil.index,
    }),
    /invalid cursor/,
  );
});

test("A11 删除后翻页不复活：跨封存块删旧条", async () => {
  resetBucket();
  const store = makeStore();
  await store.ensureInitialized();
  for (let i = 0; i < 25; i += 1) {
    await store.createMessage(PUBLIC, "u", `d${i}`);
    await new Promise((r) => setTimeout(r, 1));
  }
  // 删掉最旧那条（第 25 条，在封存块内）
  const all = await store.listMessages(PUBLIC, { limit: 50 });
  const oldest = all.items[all.items.length - 1];
  await store.deleteMessage(PUBLIC, oldest.id);

  // 全量收，确认无该 id、总数 24
  let cursor = null;
  const ids = new Set();
  for (let p = 0; p < 3; p += 1) {
    const opts = { limit: 20 };
    if (cursor) Object.assign(opts, decodeCursor(cursor));
    const res = await store.listMessages(PUBLIC, opts);
    res.items.forEach((it) => ids.add(it.id));
    if (!res.hasMore) break;
    cursor = res.nextCursor;
  }
  assert.equal(ids.size, 24);
  assert.ok(!ids.has(oldest.id));
});

// —— A12：原地修改 ——

test("A12 active 原地改：id/位置/createdAt 不变，updatedAt 更新", async () => {
  resetBucket();
  const store = makeStore();
  await store.ensureInitialized();
  await store.createMessage(PUBLIC, "原署名", "原内容");
  const before = await store.listMessages(PUBLIC, { limit: 20 });
  const item = before.items[0];
  const createdAt = item.createdAt;

  await new Promise((r) => setTimeout(r, 5));
  await store.updateMessage(PUBLIC, item.id, {
    nickname: "新署名",
    content: "新内容",
  });
  const after = await store.listMessages(PUBLIC, { limit: 20 });
  assert.equal(after.items.length, 1);
  const changed = after.items[0];
  assert.equal(changed.id, item.id); // id 不变
  assert.equal(changed.createdAt, createdAt); // createdAt 保留
  assert.equal(changed.nickname, "新署名");
  assert.equal(changed.content, "新内容");
  assert.ok(changed.updatedAt);
  assert.ok(changed.updatedAt >= changed.createdAt);
});

test("A12 封存块内原地改：id/位置不变，改后可读回", async () => {
  resetBucket();
  const store = makeStore();
  await store.ensureInitialized();
  for (let i = 0; i < 22; i += 1) {
    await store.createEntry(PUBLIC, "原心情", `正文${i}`);
    await new Promise((r) => setTimeout(r, 1));
  }
  // 找到最旧条目（在封存块内，第 22 条）
  const all = await store.listEntries(PUBLIC, { limit: 50 });
  const oldest = all.items[all.items.length - 1];
  const pos = all.items.length - 1;
  const createdAt = oldest.createdAt;

  await new Promise((r) => setTimeout(r, 5));
  await store.updateEntry(PUBLIC, oldest.id, {
    mood: "新心情",
    content: "改过的正文",
  });

  const reread = await store.listEntries(PUBLIC, { limit: 50 });
  assert.equal(reread.items.length, 22);
  assert.equal(reread.items[pos].id, oldest.id); // 位置不变
  assert.equal(reread.items[pos].createdAt, createdAt);
  assert.equal(reread.items[pos].mood, "新心情");
  assert.equal(reread.items[pos].content, "改过的正文");
  assert.ok(reread.items[pos].updatedAt);
});

test("A12 旧游标在原地改后仍有效", async () => {
  resetBucket();
  const store = makeStore();
  await store.ensureInitialized();
  for (let i = 0; i < 23; i += 1) {
    await store.createMessage(PUBLIC, "u", `c${i}`);
    await new Promise((r) => setTimeout(r, 1));
  }
  const page1 = await store.listMessages(PUBLIC, { limit: 20 });
  const oldCursor = page1.nextCursor;

  // 用游标改封存块中的一条
  const hint = decodeCursor(oldCursor);
  // 修改第二页首条（afterId 之后的新项）——改 active 与封存都可能；这里改封存块首条
  const page2 = await store.listMessages(PUBLIC, {
    limit: 20,
    afterId: hint.afterId,
    blockKey: hint.blockKey,
    index: hint.index,
  });
  const target = page2.items[0];
  await store.updateMessage(PUBLIC, target.id, { content: "原地改" });

  // 旧游标仍可取第二页且反映改动
  const again = await store.listMessages(PUBLIC, {
    limit: 20,
    afterId: hint.afterId,
    blockKey: hint.blockKey,
    index: hint.index,
  });
  assert.equal(again.items[0].id, target.id);
  assert.equal(again.items[0].content, "原地改");
});

test("A12 成员路径改已锁定条目抛 LockedError；bypassLock 可改", async () => {
  resetBucket();
  const store = makeStore();
  await store.ensureInitialized();
  await store.createMessage(PUBLIC, "u", "锁我");
  const item = (await store.listMessages(PUBLIC, { limit: 20 })).items[0];
  await store.setMessageLocked(PUBLIC, item.id, true);

  await assert.rejects(
    store.updateMessage(PUBLIC, item.id, { content: "试图改" }),
    LockedError,
  );
  // 管理员 bypassLock
  await store.updateMessage(PUBLIC, item.id, { content: "管理员改" }, {
    bypassLock: true,
  });
  const after = (await store.listMessages(PUBLIC, { limit: 20 })).items[0];
  assert.equal(after.content, "管理员改");
});

test("A12 更新不存在条目抛 NotFoundError", async () => {
  resetBucket();
  const store = makeStore();
  await store.ensureInitialized();
  await assert.rejects(
    store.updateMessage(PUBLIC, "01M3VRJR0PB6ZSQD9H3ZNSBMBP", {
      content: "x",
    }),
    NotFoundError,
  );
});
