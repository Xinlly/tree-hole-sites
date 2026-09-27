import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function createWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

async function fetchFromWorker(path, init = {}, env = {}) {
  const worker = await createWorker();
  return worker.fetch(
    new Request(`http://localhost${path}`, init),
    {
      TREE_HOLE_PASSWORD: "open-sesame",
      TREE_HOLE_ADMIN_PASSWORD: "admin-sesame",
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
      ...env,
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

function createFakeDb() {
  const data = {
    messages: [],
    secrets: [],
    nextMessageId: 1,
    nextSecretId: 1,
  };

  return {
    prepare(sql) {
      const statement = String(sql);
      return {
        bind(...values) {
          return {
            async all() {
              if (statement.includes("FROM visitor_messages")) {
                return { results: [...data.messages].sort((a, b) => b.id - a.id) };
              }
              if (statement.includes("FROM tree_hole_entries")) {
                return { results: [...data.secrets].sort((a, b) => b.id - a.id) };
              }
              return { results: [] };
            },
            async run() {
              if (statement.includes("INSERT INTO visitor_messages")) {
                data.messages.push({
                  id: data.nextMessageId++,
                  nickname: values[0],
                  content: values[1],
                  created_at: "2026-08-03 07:20:00",
                });
              }
              if (statement.includes("INSERT INTO tree_hole_entries")) {
                data.secrets.push({
                  id: data.nextSecretId++,
                  mood: values[0],
                  content: values[1],
                  reply: values[2],
                  created_at: "2026-08-03 07:21:00",
                });
              }
              if (statement.includes("DELETE FROM visitor_messages")) {
                data.messages = data.messages.filter((item) => item.id !== values[0]);
              }
              if (statement.includes("DELETE FROM tree_hole_entries")) {
                data.secrets = data.secrets.filter((item) => item.id !== values[0]);
              }
              return { success: true };
            },
          };
        },
        async all() {
          if (statement.includes("FROM visitor_messages")) {
            return { results: [...data.messages].sort((a, b) => b.id - a.id) };
          }
          if (statement.includes("FROM tree_hole_entries")) {
            return { results: [...data.secrets].sort((a, b) => b.id - a.id) };
          }
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
      };
    },
    async batch(statements) {
      await Promise.all(statements.map((statement) => statement.run()));
      return [];
    },
  };
}

async function adminCookie() {
  const response = await fetchFromWorker("/api/admin/unlock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "admin-sesame" }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie")?.split(";")[0];
}

test("renders a Chinese password gate before the tree hole", async () => {
  const response = await fetchFromWorker("/", {
    headers: { accept: "text/html" },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>嘟<\/title>/i);
  assert.match(html, /输入密码/);
  assert.match(html, /进入树洞/);
  assert.doesNotMatch(html, /涓|鎶|鏍戞礊|�/);
});

test("page includes positive moods first, bright Morandi copy, companion art, and admin mode", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /嘟/);
  assert.ok(page.indexOf("愉悦") < page.indexOf("低落"));
  assert.ok(page.indexOf("幸福") < page.indexOf("低落"));
  assert.match(page, /想对我说什么/);
  assert.match(page, /管理者查看/);
  assert.match(page, /morandi-companions\.png/);
  assert.match(page, /浅粉/);
  assert.match(page, /浅紫/);
  assert.match(page, /浅蓝/);
  assert.doesNotMatch(page, /涓|鎶|鏍戞礊|�/);
});

test("visitor password unlocks the tree hole", async () => {
  const wrong = await fetchFromWorker("/api/unlock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong" }),
  });

  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { ok: false });
  assert.equal(wrong.headers.get("set-cookie"), null);

  const correct = await fetchFromWorker("/api/unlock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "open-sesame" }),
  });

  assert.equal(correct.status, 200);
  assert.deepEqual(await correct.json(), { ok: true });
  assert.match(correct.headers.get("set-cookie") ?? "", /tree_hole_session=/);
  assert.match(correct.headers.get("set-cookie") ?? "", /HttpOnly/);
});

test("stores visitor messages with nickname and date on the server", async () => {
  const DB = createFakeDb();
  const created = await fetchFromWorker(
    "/api/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "1", content: "今天也要好好的" }),
    },
    { DB },
  );

  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { ok: true });

  const listed = await fetchFromWorker("/api/messages", {}, { DB });
  assert.equal(listed.status, 200);

  const body = await listed.json();
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].nickname, "1");
  assert.equal(body.messages[0].content, "今天也要好好的");
  assert.equal(body.messages[0].createdAt, "2026-08-03 07:20:00");
});

test("stores tree-hole entries on the server", async () => {
  const DB = createFakeDb();
  const created = await fetchFromWorker(
    "/api/entries",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mood: "幸福",
        content: "今天被温柔对待了",
        reply: "愿这份幸福被好好收藏。",
      }),
    },
    { DB },
  );

  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { ok: true });

  const listed = await fetchFromWorker("/api/entries", {}, { DB });
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.entries[0].mood, "幸福");
  assert.equal(body.entries[0].content, "今天被温柔对待了");
  assert.equal(body.entries[0].createdAt, "2026-08-03 07:21:00");
});

test("admin can view and delete server-saved entries and messages", async () => {
  const DB = createFakeDb();
  await fetchFromWorker(
    "/api/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "1", content: "一条留言" }),
    },
    { DB },
  );
  await fetchFromWorker(
    "/api/entries",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mood: "愉悦", content: "一条封存", reply: "已收到。" }),
    },
    { DB },
  );

  const cookie = await adminCookie();
  assert.ok(cookie);

  const adminView = await fetchFromWorker("/api/admin/items", {
    headers: { cookie },
  }, { DB });
  assert.equal(adminView.status, 200);
  const adminBody = await adminView.json();
  assert.equal(adminBody.messages.length, 1);
  assert.equal(adminBody.entries.length, 1);

  const deleteMessage = await fetchFromWorker("/api/admin/messages/1", {
    method: "DELETE",
    headers: { cookie },
  }, { DB });
  assert.equal(deleteMessage.status, 200);

  const deleteEntry = await fetchFromWorker("/api/admin/entries/1", {
    method: "DELETE",
    headers: { cookie },
  }, { DB });
  assert.equal(deleteEntry.status, 200);

  const empty = await fetchFromWorker("/api/admin/items", {
    headers: { cookie },
  }, { DB });
  const emptyBody = await empty.json();
  assert.equal(emptyBody.messages.length, 0);
  assert.equal(emptyBody.entries.length, 0);
});
