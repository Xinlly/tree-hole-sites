import assert from "node:assert/strict";
import test from "node:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { monotonicFactory } from "ulid";
import { gunzipSync } from "node:zlib";

process.env.STORAGE_OBJECT_ENDPOINT = "https://example.test";
process.env.STORAGE_OBJECT_REGION = "us-east-1";
process.env.STORAGE_OBJECT_BUCKET = "test-bucket";
process.env.STORAGE_OBJECT_ACCESS_KEY_ID = "test-access-key";
process.env.STORAGE_OBJECT_SECRET_ACCESS_KEY = "test-secret-key";

const s3Mock = mockClient(S3Client);

const PUBLIC_SCOPE = { kind: "public", id: "" };

// 内存中的假桶：Put 写入、Get 读出，缺 key 抛 NoSuchKey；
// ListObjectsV2 按 Prefix/StartAfter 字典序升序返回
function setupBackend() {
  const bucket = new Map();
  s3Mock.reset();
  s3Mock
    .on(PutObjectCommand)
    .callsFake(async (input) => {
      bucket.set(input.Key, input.Body);
      return {};
    });
  s3Mock
    .on(GetObjectCommand)
    .callsFake(async (input) => {
      if (!bucket.has(input.Key)) {
        const error = new Error("The specified key does not exist.");
        error.name = "NoSuchKey";
        throw error;
      }
      return { Body: bucket.get(input.Key) };
    });
  s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
    const prefix = input.Prefix ?? "";
    const startAfter = input.StartAfter ?? "";
    const keys = [...bucket.keys()]
      .filter(
        (key) => key.startsWith(prefix) && key > startAfter,
      )
      .sort();
    return { Contents: keys.map((Key) => ({ Key })) };
  });
  return bucket;
}

async function makeStore(tag) {
  const mod = await import(`../app/api/store/object-store.ts?t=${tag}`);
  return new mod.ObjectStore();
}

async function addMessages(store, count, prefix = "留言") {
  for (let i = 0; i < count; i += 1) {
    // 逐条加微小间隔，避免同毫秒，便于断言顺序稳定
    await store.createMessage(PUBLIC_SCOPE, "用户", `${prefix}${i + 1}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("F2: at 20 the newest are sealed into one immutable block and active clears", async () => {
  const bucket = setupBackend();
  const store = await makeStore("f2");
  await store.ensureInitialized();
  await addMessages(store, 20);

  const state = JSON.parse(await inflateGet(bucket, "v3/public/messages/state.json.gz"));
  assert.equal(state.active.length, 0);
  assert.equal(typeof state.headBlockKey, "string");
  assert.match(state.headBlockKey, /^v3\/public\/messages\/blocks\/.+\.json\.gz$/);

  const block = JSON.parse(await inflateGet(bucket, state.headBlockKey));
  assert.equal(block.items.length, 20);
  // 块内新在前（id 倒序）
  assert.ok(block.items[0].id > block.items[19].id);
  assert.equal(block.items[0].content, "留言20");
  assert.equal(block.items[19].content, "留言1");

  const all = await store.listMessages(PUBLIC_SCOPE, { limit: 50 });
  assert.equal(all.items.length, 20);
  assert.equal(all.hasMore, false);
  assert.equal(all.items[0].content, "留言20");
  assert.equal(all.items[19].content, "留言1");
});

test("F3: active 1 + block 20, first screen of 20 spans the boundary with no dup", async () => {
  setupBackend();
  const store = await makeStore("f3");
  await store.ensureInitialized();
  await addMessages(store, 20);
  await store.createMessage(PUBLIC_SCOPE, "新人", "最新的一条");

  const page = await store.listMessages(PUBLIC_SCOPE, { limit: 20 });
  assert.equal(page.items.length, 20);
  assert.equal(page.items[0].content, "最新的一条");
  assert.equal(page.items[1].content, "留言20");
  assert.equal(page.items[19].content, "留言2");
  assert.equal(page.hasMore, true);

  // 无重复
  const ids = page.items.map((item) => item.id);
  assert.equal(new Set(ids).size, 20);

  const lastId = page.items[19].id;
  const next = await store.listMessages(PUBLIC_SCOPE, { limit: 20, afterId: lastId });
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].content, "留言1");
  assert.equal(next.hasMore, false);
});

test("F4: delete in active removes; delete in block adds tombstone and leaves block bytes intact", async () => {
  const bucket = setupBackend();
  const store = await makeStore("f4");
  await store.ensureInitialized();
  await addMessages(store, 20);
  await store.createMessage(PUBLIC_SCOPE, "新人", "活动区这条");

  // active 删除
  const before = await store.listMessages(PUBLIC_SCOPE, { limit: 21 });
  const activeId = before.items[0].id;
  await store.deleteMessage(PUBLIC_SCOPE, activeId);
  let listed = await store.listMessages(PUBLIC_SCOPE, { limit: 21 });
  assert.ok(!listed.items.some((item) => item.id === activeId));
  assert.equal(listed.items[0].content, "留言20");

  // 块内删除：记录块字节
  const state = JSON.parse(await inflateGet(bucket, "v3/public/messages/state.json.gz"));
  const bytesBefore = Buffer.from(bucket.get(state.headBlockKey));
  const blockId = listed.items[0].id; // 留言20，在块内
  await store.deleteMessage(PUBLIC_SCOPE, blockId);
  const bytesAfter = Buffer.from(bucket.get(state.headBlockKey));
  assert.ok(bytesBefore.equals(bytesAfter)); // 封存块字节不变

  listed = await store.listMessages(PUBLIC_SCOPE, { limit: 21 });
  assert.ok(!listed.items.some((item) => item.id === blockId));
  assert.equal(listed.items[0].content, "留言19");
});

test("F5: tombstones at logical positions 0/19/20/39 page without dup/gap, correct hasMore", async () => {
  setupBackend();
  const store = await makeStore("f5");
  await store.ensureInitialized();
  await addMessages(store, 40);

  // 逻辑顺序（新→旧）id 列表
  const full = await store.listMessages(PUBLIC_SCOPE, { limit: 100 });
  assert.equal(full.items.length, 40);
  const posIds = [0, 19, 20, 39].map((pos) => full.items[pos].id);
  for (const id of posIds) {
    await store.deleteMessage(PUBLIC_SCOPE, id);
  }

  // limit=20 连续翻页
  const pages = [];
  let cursor = null;
  for (let i = 0; i < 5; i += 1) {
    const opts = { limit: 20 };
    if (cursor) {
      Object.assign(opts, decodeCursorSafe(cursor));
    }
    const page = await store.listMessages(PUBLIC_SCOPE, opts);
    pages.push(page);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }

  const returnedIds = pages.flatMap((page) => page.items.map((item) => item.id));
  assert.equal(returnedIds.length, 36);
  assert.equal(new Set(returnedIds).size, 36); // 无重复
  // 无遗漏：存活 id = 全量减去墓碑
  const alive = full.items.map((item) => item.id).filter((id) => !posIds.includes(id));
  assert.deepEqual([...returnedIds], alive);
  // 顺序新→旧
  for (let i = 1; i < returnedIds.length; i += 1) {
    assert.ok(returnedIds[i - 1] > returnedIds[i]);
  }
  assert.equal(pages[0].items.length, 20);
  assert.equal(pages[1].items.length, 16);
  assert.equal(pages[1].hasMore, false);
});

test("F6.1: item added between pages is not re-served; visible via top refresh", async () => {
  setupBackend();
  const store = await makeStore("f61");
  await store.ensureInitialized();
  await addMessages(store, 25);

  const first = await store.listMessages(PUBLIC_SCOPE, { limit: 20 });
  assert.equal(first.items.length, 20);
  const firstIds = new Set(first.items.map((item) => item.id));

  // 翻页间新增
  await store.createMessage(PUBLIC_SCOPE, "后来者", "翻页间新增");
  const decoded = decodeCursorSafe(first.nextCursor);
  const second = await store.listMessages(PUBLIC_SCOPE, { limit: 20, ...decoded });
  // 后续页不重发上页项
  assert.ok(second.items.every((item) => !firstIds.has(item.id)));
  // 新留言 id > afterId，不在本窗口
  assert.ok(!second.items.some((item) => item.content === "翻页间新增"));
  assert.deepEqual(second.items.map((item) => item.content), [
    "留言5", "留言4", "留言3", "留言2", "留言1",
  ]);
  assert.equal(second.hasMore, false);

  // 顶部刷新：新留言在最前
  const refreshed = await store.listMessages(PUBLIC_SCOPE, { limit: 20 });
  assert.equal(refreshed.items[0].content, "翻页间新增");
});

test("F6.2: deleting an active item between pages does not skip later items", async () => {
  setupBackend();
  const store = await makeStore("f62");
  await store.ensureInitialized();
  await addMessages(store, 25); // active5 + block20

  // limit=10：首页吃 active 前 10? active 仅5 → active5 + 块5
  const first = await store.listMessages(PUBLIC_SCOPE, { limit: 10 });
  assert.deepEqual(first.items.slice(0, 5).map((i) => i.content), [
    "留言25", "留言24", "留言23", "留言22", "留言21",
  ]);
  // 翻页间删除 active 内一项（首页已返回的 #24）
  await store.deleteMessage(PUBLIC_SCOPE, first.items[1].id);
  const decoded = decodeCursorSafe(first.nextCursor);
  const second = await store.listMessages(PUBLIC_SCOPE, { limit: 10, ...decoded });
  // afterId 阈值扫描，块侧不跳条
  assert.equal(second.items[0].content, "留言15");
  assert.equal(second.items.length, 10);
});

test("F6.3: a seal between pages keeps the cursor valid along the new block", async () => {
  setupBackend();
  const store = await makeStore("f63");
  await store.ensureInitialized();
  await addMessages(store, 19); // active19，无块

  const first = await store.listMessages(PUBLIC_SCOPE, { limit: 10 });
  assert.equal(first.items.length, 10);
  assert.equal(first.items[0].content, "留言19");

  // 翻页间：第 20 条写入触发封存，active 清空
  await store.createMessage(PUBLIC_SCOPE, "用户", "留言20");
  const decoded = decodeCursorSafe(first.nextCursor);
  const second = await store.listMessages(PUBLIC_SCOPE, { limit: 10, ...decoded });
  // 游标沿块取到后续、不重发
  const firstContents = new Set(first.items.map((i) => i.content));
  assert.ok(second.items.every((item) => !firstContents.has(item.content)));
  assert.deepEqual(second.items.map((i) => i.content), [
    "留言9", "留言8", "留言7", "留言6", "留言5",
    "留言4", "留言3", "留言2", "留言1",
  ]);
  assert.equal(second.hasMore, false);
});

test("F6.4: a fully-tombstoned block is consumed across blocks in one request", async () => {
  setupBackend();
  const store = await makeStore("f64");
  await store.ensureInitialized();
  await addMessages(store, 40); // block2(新,#21-40) + block1(旧,#1-20)

  // 给较新块 block2 全部 20 条加墓碑
  const full = await store.listMessages(PUBLIC_SCOPE, { limit: 100 });
  const newerBlockIds = full.items.slice(0, 20).map((item) => item.id);
  for (const id of newerBlockIds) {
    await store.deleteMessage(PUBLIC_SCOPE, id);
  }

  // 一请求 limit=20：跨全墓碑块直接从旧块取满 20，无 API 级空页
  const page = await store.listMessages(PUBLIC_SCOPE, { limit: 20 });
  assert.equal(page.items.length, 20);
  assert.equal(page.items[0].content, "留言20");
  assert.equal(page.items[19].content, "留言1");
  assert.equal(page.hasMore, false);
});

test("F6.5: walking ≥3 sealed blocks keeps order and boundaries", async () => {
  setupBackend();
  const store = await makeStore("f65");
  await store.ensureInitialized();
  await addMessages(store, 60); // 3 块，无 active

  const pages = [];
  let cursor = null;
  for (let i = 0; i < 3; i += 1) {
    const opts = { limit: 20 };
    if (cursor) {
      Object.assign(opts, decodeCursorSafe(cursor));
    }
    const page = await store.listMessages(PUBLIC_SCOPE, opts);
    pages.push(page);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }

  assert.equal(pages.length, 3);
  assert.deepEqual(pages[0].items.map((i) => i.content), contentsRange(60, 41));
  assert.deepEqual(pages[1].items.map((i) => i.content), contentsRange(40, 21));
  assert.deepEqual(pages[2].items.map((i) => i.content), contentsRange(20, 1));
  assert.equal(pages[0].hasMore, true);
  assert.equal(pages[1].hasMore, true);
  assert.equal(pages[2].hasMore, false);

  const ids = pages.flatMap((p) => p.items.map((i) => i.id));
  assert.equal(new Set(ids).size, 60);
});

test("F6.6: active=20 left by an interrupted seal seals normally on next write", async () => {
  const bucket = setupBackend();
  const store = await makeStore("f66");
  await store.ensureInitialized();

  // 直接构造封存中断遗留：state.active=20、headBlockKey=null
  const newId = monotonicFactory();
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: newId(Date.UTC(2026, 8, 1, 0, 0, i)),
    nickname: "用户",
    content: `遗留${i + 1}`,
    createdAt: "2026-09-01 00:00:00",
  })).reverse(); // active 新在前
  await putGz(bucket, "v3/public/messages/state.json.gz", {
    version: 3,
    active: items,
    headBlockKey: null,
    tombstonesKey: "v3/public/messages/tombstones.json.gz",
    updatedAt: Date.now(),
  });

  // 再写入：active 变 21，>=20 正常封存恢复
  await store.createMessage(PUBLIC_SCOPE, "用户", "恢复后新写");

  const state = JSON.parse(await inflateGet(bucket, "v3/public/messages/state.json.gz"));
  assert.equal(state.active.length, 1);
  assert.equal(state.active[0].content, "恢复后新写");
  assert.equal(typeof state.headBlockKey, "string");

  const all = await store.listMessages(PUBLIC_SCOPE, { limit: 50 });
  assert.equal(all.items.length, 21);
  assert.equal(all.items[0].content, "恢复后新写");
  assert.equal(all.items[1].content, "遗留20");
  assert.equal(all.items[20].content, "遗留1");
  assert.equal(new Set(all.items.map((i) => i.id)).size, 21);
});

test("afterId across active/block boundary: page ends exactly at active last item", async () => {
  setupBackend();
  const store = await makeStore("boundary");
  await store.ensureInitialized();
  await addMessages(store, 25); // active5 (#25-21) + block20

  const first = await store.listMessages(PUBLIC_SCOPE, { limit: 5 });
  assert.deepEqual(first.items.map((i) => i.content), [
    "留言25", "留言24", "留言23", "留言22", "留言21",
  ]);
  assert.equal(first.hasMore, true);
  // 断点恰为 active 最后一项，cursor 无 block hint
  const decoded = decodeCursorSafe(first.nextCursor);
  assert.equal(decoded.blockKey, undefined);

  const second = await store.listMessages(PUBLIC_SCOPE, { limit: 5, ...decoded });
  assert.deepEqual(second.items.map((i) => i.content), [
    "留言20", "留言19", "留言18", "留言17", "留言16",
  ]);
});

test("malformed cursor is rejected by decodeCursor", async () => {
  const { decodeCursor } = await import("../app/api/store/cursor.ts");
  assert.throws(() => decodeCursor("not-base64!!!"), /invalid cursor/);
  const malformedJson = Buffer.from(JSON.stringify({ afterId: "abc" })).toString("base64");
  assert.throws(() => decodeCursor(malformedJson), /invalid cursor/);
  const badId = Buffer.from(
    JSON.stringify({ afterId: "not-a-ulid" }),
  ).toString("base64");
  assert.throws(() => decodeCursor(badId), /invalid cursor/);
});

test("P1-2: fresh bucket without any init supports createMessage and listMessages", async () => {
  setupBackend();
  const store = await makeStore("p1-2");
  // 不调用 ensureInitialized，空桶直接写读
  await store.createMessage(PUBLIC_SCOPE, "小明", "全新桶第一条");

  const page = await store.listMessages(PUBLIC_SCOPE, { limit: 20 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].nickname, "小明");
  assert.equal(page.items[0].content, "全新桶第一条");
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});

test("P1-4: shuffled block LIST still yields global id-descending order", async () => {
  const bucket = setupBackend();
  const store = await makeStore("p1-4");
  await store.ensureInitialized();
  await addMessages(store, 60); // active0 + 3 块

  // LIST 返回反序（旧块在前），打乱正常 key 升序
  s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
    const prefix = input.Prefix ?? "";
    const startAfter = input.StartAfter ?? "";
    const keys = [...bucket.keys()]
      .filter((key) => key.startsWith(prefix) && key > startAfter)
      .reverse();
    return { Contents: keys.map((Key) => ({ Key })) };
  });

  const page = await store.listMessages(PUBLIC_SCOPE, { limit: 50 });
  assert.equal(page.items.length, 50);
  assert.equal(page.hasMore, true);
  // 排序防线：全局最新 50 条，严格 id 降序
  assert.deepEqual(page.items.map((i) => i.content), contentsRange(60, 11));
  const ids = page.items.map((i) => i.id);
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(ids[i - 1] > ids[i]);
  }
});

test("orphan block then re-seal: deep pagination never returns duplicate ids", async () => {
  const bucket = setupBackend();
  const store = await makeStore("orphan");
  await store.ensureInitialized();
  await addMessages(store, 19); // active19，无块

  // 第 20 条触发封存：块 O 成功，模拟 state PUT 前崩溃。
  // 崩溃后桶内 state 恢复为 reviewer 所述：active20（同批 20 项）、head=null。
  let crashed = false;
  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    if (
      !crashed &&
      input.Key === "v3/public/messages/state.json.gz"
    ) {
      crashed = true;
      const blockEntries = [...bucket.keys()].filter((key) =>
        key.startsWith("v3/public/messages/blocks/"),
      );
      assert.equal(blockEntries.length, 1); // 孤儿块 O 已落
      const orphanText = new TextDecoder().decode(
        gunzipSync(bucket.get(blockEntries[0])),
      );
      const orphanItems = JSON.parse(orphanText).items;
      // state 未记录 head，active 仍持这批 20 项（新在前）
      await putGz(bucket, input.Key, {
        version: 3,
        active: [...orphanItems],
        headBlockKey: null,
        tombstonesKey: "v3/public/messages/tombstones.json.gz",
        updatedAt: Date.now(),
      });
      return {};
    }
    bucket.set(input.Key, input.Body);
    return {};
  });

  await store.createMessage(PUBLIC_SCOPE, "用户", "留言20");
  assert.equal(crashed, true);

  // 恢复后再写 1 条 → active21，封存最旧 20：与孤儿 O 同批 → 新块 N
  await store.createMessage(PUBLIC_SCOPE, "用户", "留言21");
  const blockKeys = [...bucket.keys()].filter((key) =>
    key.startsWith("v3/public/messages/blocks/"),
  );
  assert.equal(blockKeys.length, 2); // 孤儿 O + 新封存 N

  // limit=20 连续翻到末页
  const collected = [];
  let cursor = null;
  for (;;) {
    const opts = { limit: 20 };
    if (cursor) {
      Object.assign(opts, decodeCursorSafe(cursor));
    }
    const page = await store.listMessages(PUBLIC_SCOPE, opts);
    collected.push(...page.items);
    if (!page.hasMore) {
      break;
    }
    cursor = page.nextCursor;
  }

  // 非空断言 + 去重防线
  assert.equal(collected.length, 21); // 21 条，不出现 22
  const ids = collected.map((item) => item.id);
  assert.equal(new Set(ids).size, 21); // 跨全部页 id 无重复
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(ids[i - 1] > ids[i]); // 全局 id 降序
  }
  assert.deepEqual(collected.map((item) => item.content), contentsRange(21, 1));
});

test("active delete before orphaned block: deleted id never resurrects; tombstone persisted", async () => {
  const bucket = setupBackend();
  const store = await makeStore("orphan-revive");
  await store.ensureInitialized();
  await addMessages(store, 19); // active19，无块

  // 第 20 条触发封存：块 O 成功、state PUT 崩溃；写回 active20（留言20..1）/head=null
  let crashed = false;
  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    if (!crashed && input.Key === "v3/public/messages/state.json.gz") {
      crashed = true;
      const blockKeyEntry = [...bucket.keys()].find((key) =>
        key.startsWith("v3/public/messages/blocks/"),
      );
      const orphanItems = JSON.parse(
        new TextDecoder().decode(gunzipSync(bucket.get(blockKeyEntry))),
      ).items;
      await putGz(bucket, input.Key, {
        version: 3,
        active: [...orphanItems],
        headBlockKey: null,
        tombstonesKey: "v3/public/messages/tombstones.json.gz",
        updatedAt: Date.now(),
      });
      return {};
    }
    bucket.set(input.Key, input.Body);
    return {};
  });
  await store.createMessage(PUBLIC_SCOPE, "用户", "留言20");
  assert.equal(crashed, true);

  // 删除 active 中的留言5：先墓碑后 state（墓碑同时屏蔽孤儿 O 中的副本）
  const stateBefore = JSON.parse(
    new TextDecoder().decode(gunzipSync(bucket.get("v3/public/messages/state.json.gz"))),
  );
  const cur5 = stateBefore.active.find((item) => item.content === "留言5");
  await store.deleteMessage(PUBLIC_SCOPE, cur5.id);

  // 墓碑集合含 cur5
  const tombstones = JSON.parse(
    new TextDecoder().decode(
      gunzipSync(bucket.get("v3/public/messages/tombstones.json.gz")),
    ),
  );
  assert.ok(tombstones.includes(cur5.id));

  // 再写 1 条触发新封存 N
  await store.createMessage(PUBLIC_SCOPE, "用户", "留言21");
  const blockKeys = [...bucket.keys()].filter((key) =>
    key.startsWith("v3/public/messages/blocks/"),
  );
  assert.equal(blockKeys.length, 2);

  // limit=20/5/1 三种翻页，均断言 cur5 不复活、总数 20、id 降序无重复
  const expectedContents = [
    ...contentsRange(21, 6),
    ...contentsRange(4, 1),
  ];
  for (const limit of [20, 5, 1]) {
    const collected = [];
    let cursor = null;
    for (;;) {
      const opts = { limit };
      if (cursor) {
        Object.assign(opts, decodeCursorSafe(cursor));
      }
      const page = await store.listMessages(PUBLIC_SCOPE, opts);
      collected.push(...page.items);
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    assert.equal(collected.length, 20);
    const ids = collected.map((item) => item.id);
    assert.equal(new Set(ids).size, 20);
    assert.ok(!ids.includes(cur5.id));
    for (let i = 1; i < ids.length; i += 1) {
      assert.ok(ids[i - 1] > ids[i]);
    }
    assert.deepEqual(collected.map((item) => item.content), expectedContents);
  }
});

test("delete ordering: tombstone failure leaves state intact; state crash replays safely", async () => {
  const bucket = setupBackend();
  const store = await makeStore("delete-order");
  await store.ensureInitialized();
  await addMessages(store, 19);

  let crashed = false;
  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    if (!crashed && input.Key === "v3/public/messages/state.json.gz") {
      crashed = true;
      const blockKeyEntry = [...bucket.keys()].find((key) =>
        key.startsWith("v3/public/messages/blocks/"),
      );
      const orphanItems = JSON.parse(
        new TextDecoder().decode(gunzipSync(bucket.get(blockKeyEntry))),
      ).items;
      await putGz(bucket, input.Key, {
        version: 3,
        active: [...orphanItems],
        headBlockKey: null,
        tombstonesKey: "v3/public/messages/tombstones.json.gz",
        updatedAt: Date.now(),
      });
      return {};
    }
    bucket.set(input.Key, input.Body);
    return {};
  });
  await store.createMessage(PUBLIC_SCOPE, "用户", "留言20");
  assert.equal(crashed, true);

  const cur5 = JSON.parse(
    new TextDecoder().decode(gunzipSync(bucket.get("v3/public/messages/state.json.gz"))),
  ).active.find((item) => item.content === "留言5");
  const TOMB_KEY = "v3/public/messages/tombstones.json.gz";
  const STATE_KEY = "v3/public/messages/state.json.gz";

  // 阶段 A：putTombstones 失败 → state 未改、删除整体失败（可重试）
  const stateBytesA = Buffer.from(bucket.get(STATE_KEY));
  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    if (input.Key === TOMB_KEY) {
      throw new Error("tombstone write failed");
    }
    bucket.set(input.Key, input.Body);
    return {};
  });
  await assert.rejects(store.deleteMessage(PUBLIC_SCOPE, cur5.id), /tombstone write failed/);
  const stateAfterA = JSON.parse(
    new TextDecoder().decode(gunzipSync(bucket.get(STATE_KEY))),
  );
  assert.equal(stateAfterA.active.length, 20);
  assert.ok(stateAfterA.active.some((item) => item.id === cur5.id));
  assert.ok(stateBytesA.equals(Buffer.from(bucket.get(STATE_KEY)))); // state 字节未变
  assert.equal(bucket.has(TOMB_KEY), false); // 墓碑未落地

  // 阶段 B：墓碑成功，但随后 putState 崩溃（state 保留旧 active20）
  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    if (input.Key === TOMB_KEY) {
      bucket.set(input.Key, input.Body);
      return {};
    }
    if (input.Key === STATE_KEY) {
      throw new Error("state write crashed");
    }
    bucket.set(input.Key, input.Body);
    return {};
  });
  await assert.rejects(store.deleteMessage(PUBLIC_SCOPE, cur5.id), /state write crashed/);

  // 恢复后重放删除（正常写入）：墓碑已含 id（去重不重复追加），state 正常更新
  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    bucket.set(input.Key, input.Body);
    return {};
  });
  await store.deleteMessage(PUBLIC_SCOPE, cur5.id);

  // 全量翻页：cur5 对所有副本（含孤儿 O）均不返回，其余 19 条完好、id 降序
  const collected = [];
  let cursor = null;
  for (;;) {
    const opts = { limit: 5 };
    if (cursor) {
      Object.assign(opts, decodeCursorSafe(cursor));
    }
    const page = await store.listMessages(PUBLIC_SCOPE, opts);
    collected.push(...page.items);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  const ids = collected.map((item) => item.id);
  assert.equal(collected.length, 19);
  assert.equal(new Set(ids).size, 19);
  assert.ok(!ids.includes(cur5.id));
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(ids[i - 1] > ids[i]);
  }
  assert.deepEqual(
    collected.map((item) => item.content),
    [...contentsRange(20, 6), ...contentsRange(4, 1)],
  );
});

// ---- helpers ----

test("orphan block before a real older block: deep pages keep all 41 ids incl old1", async () => {
  const bucket = setupBackend();
  const store = await makeStore("orphan-older");
  await store.ensureInitialized();
  await addMessages(store, 20, "old"); // 封存 C：active0/head=C
  await addMessages(store, 19, "cur"); // active=cur19（新在前）/head=C，未封存

  // 第 20 条 cur 触发封存：块 O（cur20…cur1 共20）PUT 成功，state PUT 崩溃。
  // 崩溃写回旧 state（active=cur19/head=C，不含 cur20）→ O 孤儿。
  const stateKey = "v3/public/messages/state.json.gz";
  let oldHeadC = "";
  let orphanO = "";
  let crashed = false;
  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    if (!crashed && input.Key === stateKey) {
      crashed = true;
      const previous = JSON.parse(
        new TextDecoder().decode(gunzipSync(bucket.get(stateKey))),
      );
      oldHeadC = previous.headBlockKey;
      // 刚写的块 O = blocks 中排除旧 head C 的那一个
      orphanO = [...bucket.keys()].find(
        (key) =>
          key.startsWith("v3/public/messages/blocks/") && key !== oldHeadC,
      );
      // 原样写回旧 state：active=cur19/head=C
      await putGz(bucket, stateKey, previous);
      return {};
    }
    bucket.set(input.Key, input.Body);
    return {};
  });

  await store.createMessage(PUBLIC_SCOPE, "用户", "cur20");
  assert.equal(crashed, true);
  assert.ok(orphanO);
  assert.ok(oldHeadC);

  // 重启写 X：active=[X,...cur19]=20 → 整体封存为 N（X+cur19..cur1），active=[]/head=N
  await store.createMessage(PUBLIC_SCOPE, "用户", "X");
  const blockKeys = [...bucket.keys()].filter((key) =>
    key.startsWith("v3/public/messages/blocks/"),
  );
  assert.equal(blockKeys.length, 3);
  const newN = blockKeys.find((key) => key !== orphanO && key !== oldHeadC);
  // 块 key 字典序：N < O < C（越新 inverted key 越小）
  assert.ok(newN < orphanO);
  assert.ok(orphanO < oldHeadC);

  // limit=20 连续翻到末页
  const collected = [];
  let cursor = null;
  for (;;) {
    const opts = { limit: 20 };
    if (cursor) {
      Object.assign(opts, decodeCursorSafe(cursor));
    }
    const page = await store.listMessages(PUBLIC_SCOPE, opts);
    collected.push(...page.items);
    if (!page.hasMore) {
      // 末页 hasMore=false、nextCursor=null
      assert.equal(page.nextCursor, null);
      break;
    }
    cursor = page.nextCursor;
  }

  const ids = collected.map((item) => item.id);
  assert.equal(collected.length, 41); // 41 条，不是 40
  assert.equal(new Set(ids).size, 41); // unique=41 无重复
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(ids[i - 1] > ids[i]); // 全局 id 降序
  }
  // old1 必须被返回（此前漏条）
  assert.ok(collected.some((item) => item.content === "old1"));
  const expected = [
    "X",
    ...contentsRangeNamed("cur", 20, 1),
    ...contentsRangeNamed("old", 20, 1),
  ];
  assert.deepEqual(collected.map((item) => item.content), expected);
});

// 真机 AWS SDK 的 GetObject Body 是 SdkStream（非 Uint8Array）。
// 旧代码用 transformToString()（默认 utf-8）解码 gzip 字节，真机报 incorrect header check。
// 本测试把 GetObject 返回包成 SdkStream 形态，钉住二进制按字节读取。
test("real S3 SdkStream body (transformToByteArray) is gunzipped correctly", async () => {
  const sdkStreamBucket = setupBackend();
  const store = await makeStore("sdkstream");
  await store.ensureInitialized();
  await addMessages(store, 3);

  // 覆写 GetObject：把 Buffer 包成只暴露 SdkStream 方法的对象（不是 Uint8Array）
  s3Mock.on(GetObjectCommand).callsFake(async (input) => {
    const bytes = sdkStreamBucket.get(input.Key);
    if (!bytes) {
      const error = new Error("The specified key does not exist.");
      error.name = "NoSuchKey";
      throw error;
    }
    return {
      Body: {
        transformToByteArray: async () => bytes,
        transformToString: async () => new TextDecoder().decode(bytes), // 默认 utf8，若被走会坏
      },
    };
  });

  const page = await store.listMessages(PUBLIC_SCOPE, { limit: 20 });
  assert.equal(page.items.length, 3);
  assert.equal(page.items[0].content, "留言3");
  assert.equal(page.items[2].content, "留言1");
});

// ---- helpers ----
async function inflateGet(bucket, key) {
  const { gunzipSync } = await import("node:zlib");
  return new TextDecoder().decode(gunzipSync(bucket.get(key)));
}

async function putGz(bucket, key, value) {
  const { gzipSync } = await import("node:zlib");
  bucket.set(key, gzipSync(Buffer.from(JSON.stringify(value), "utf8")));
}

function decodeCursorSafe(cursor) {
  // 测试内同步解码；cursor 来自 store 编码，必合法
  const json = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  const out = { afterId: json.afterId };
  if (json.blockKey) {
    out.blockKey = json.blockKey;
    out.index = json.index;
  }
  return out;
}

function contentsRange(from, to) {
  const out = [];
  for (let i = from; i >= to; i -= 1) {
    out.push(`留言${i}`);
  }
  return out;
}

function contentsRangeNamed(prefix, from, to) {
  const out = [];
  for (let i = from; i >= to; i -= 1) {
    out.push(`${prefix}${i}`);
  }
  return out;
}
