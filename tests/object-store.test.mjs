import assert from "node:assert/strict";
import test from "node:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

process.env.STORAGE_OBJECT_ENDPOINT = "https://example.test";
process.env.STORAGE_OBJECT_REGION = "us-east-1";
process.env.STORAGE_OBJECT_BUCKET = "test-bucket";
process.env.STORAGE_OBJECT_ACCESS_KEY_ID = "test-access-key";
process.env.STORAGE_OBJECT_SECRET_ACCESS_KEY = "test-secret-key";

const s3Mock = mockClient(S3Client);

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const MESSAGE_KEY = "visitor-messages.json";
const ENTRY_KEY = "tree-hole-entries.json";

// 内存中的假桶：Put 写入、Get 读出，缺 key 抛 NoSuchKey
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
  return bucket;
}

async function makeStore(tag) {
  const mod = await import(`../app/api/store/object-store.ts?t=${tag}`);
  const store = new mod.ObjectStore();
  return store;
}

test("ensureInitialized: NoSuchKey becomes an empty collection with initial structure", async () => {
  const bucket = setupBackend();
  const store = await makeStore("init");

  await store.ensureInitialized();

  assert.equal(bucket.size, 2);
  assert.deepEqual(JSON.parse(bucket.get(MESSAGE_KEY)), {
    nextId: 1,
    items: [],
  });
  assert.deepEqual(JSON.parse(bucket.get(ENTRY_KEY)), {
    nextId: 1,
    items: [],
  });

  // 已存在对象时不覆盖
  await store.ensureInitialized();
  assert.equal(bucket.size, 2);
});

test("createMessage: monotonic ids, UTC timestamp format, Chinese fidelity", async () => {
  setupBackend();
  const store = await makeStore("create");
  await store.ensureInitialized();

  await store.createMessage("小明", "今天也要开心😊");
  await store.createMessage("阿珍", "把秘密放进树洞");

  const messages = await store.listMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 2);
  assert.equal(messages[0].nickname, "阿珍");
  assert.equal(messages[0].content, "把秘密放进树洞");
  assert.match(messages[0].createdAt, TIMESTAMP_RE);
  assert.equal(messages[1].id, 1);
  assert.equal(messages[1].nickname, "小明");
  assert.equal(messages[1].content, "今天也要开心😊");
});

test("deleteMessage: removed item disappears from list", async () => {
  setupBackend();
  const store = await makeStore("delete");
  await store.ensureInitialized();

  await store.createMessage("小明", "第一条");
  await store.createMessage("阿珍", "第二条");
  const before = await store.listMessages();
  await store.deleteMessage(before[0].id);

  const after = await store.listMessages();
  assert.equal(after.length, 1);
  assert.equal(after[0].content, "第一条");
});

test("append beyond 100 trims the smallest id and keeps nextId advancing", async () => {
  const bucket = setupBackend();
  const store = await makeStore("trim");
  await store.ensureInitialized();

  for (let i = 0; i < 101; i += 1) {
    await store.createMessage("用户", `第${i + 1}条`);
  }

  const persisted = JSON.parse(bucket.get(MESSAGE_KEY));
  assert.equal(persisted.items.length, 100);
  assert.equal(persisted.nextId, 102);
  assert.equal(persisted.items[0].id, 2);
  assert.equal(persisted.items[99].id, 101);

  const listed = await store.listMessages();
  assert.equal(listed.length, 100);
  assert.equal(listed[0].id, 101);
  assert.equal(listed[99].id, 2);
});

test("listEntries returns newest first", async () => {
  setupBackend();
  const store = await makeStore("entries");
  await store.ensureInitialized();

  await store.createEntry("开心", "内容一", "回复一");
  await store.createEntry("平静", "内容二", "回复二");
  await store.createEntry("期待", "内容三", "回复三");

  const entries = await store.listEntries();
  assert.deepEqual(entries.map((entry) => entry.id), [3, 2, 1]);
  assert.equal(entries[0].mood, "期待");
  assert.equal(entries[0].reply, "回复三");
});

test("concurrent creates through the serial chain lose no id", async () => {
  setupBackend();
  const store = await makeStore("concurrent");
  await store.ensureInitialized();

  await Promise.all([
    store.createMessage("甲", "并发一"),
    store.createMessage("乙", "并发二"),
  ]);

  const messages = await store.listMessages();
  assert.deepEqual(messages.map((message) => message.id), [2, 1]);
  const contents = messages.map((message) => message.content).sort();
  assert.deepEqual(contents, ["并发一", "并发二"]);
});

test("a failing task does not break the chain tail", async () => {
  const bucket = setupBackend();
  const store = await makeStore("recover");
  await store.ensureInitialized();

  // 下一次 Get 抛非 NoSuchKey 错误，之后恢复原桶逻辑
  let failNextGet = true;
  s3Mock.on(GetObjectCommand).callsFake(async (input) => {
    if (failNextGet) {
      failNextGet = false;
      throw new Error("SlowDown");
    }
    if (!bucket.has(input.Key)) {
      const error = new Error("The specified key does not exist.");
      error.name = "NoSuchKey";
      throw error;
    }
    return { Body: bucket.get(input.Key) };
  });
  await assert.rejects(store.listMessages(), /SlowDown/);

  // 一次性失败后链未被污染：后续任务正常
  await store.createMessage("康复", "链还活着");
  const messages = await store.listMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "链还活着");
});
