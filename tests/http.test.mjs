import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = await mkdtemp(path.join(os.tmpdir(), "tree-hole-http-"));
const baseUrl = "http://127.0.0.1:3100";
const server = spawn(process.execPath, ["server.js"], {
  cwd: path.join(root, ".next/standalone"),
  env: {
    ...process.env,
    PORT: "3100",
    HOSTNAME: "127.0.0.1",
    TREE_HOLE_PASSWORD: "open-sesame",
    TREE_HOLE_ADMIN_PASSWORD: "admin-sesame",
    TREE_HOLE_DB_PATH: path.join(tmp, "http.db"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

test.after(async () => {
  server.kill();
  await rm(tmp, { recursive: true, force: true });
});

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok || response.status === 401) return;
    } catch {
      // server not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("standalone server did not become ready");
}

async function login(pathName, password) {
  return fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

test("standalone server: auth gate, scoped writing and admin cleanup", async () => {
  await waitForServer();

  const lockedPage = await fetch(`${baseUrl}/`);
  assert.equal(lockedPage.status, 200);
  const lockedHtml = await lockedPage.text();
  assert.equal(lockedHtml.includes("今天想写点什么？"), false);

  const wrongPassword = await login("/api/unlock", "nope");
  assert.equal(wrongPassword.status, 401);

  const unlocked = await login("/api/unlock", "open-sesame");
  assert.equal(unlocked.status, 200);
  const setCookie = unlocked.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /tree_hole_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.doesNotMatch(setCookie, /(?:^|;\s*)Secure(?:;|$)/);
  const sessionCookie = setCookie.split(";")[0];

  // 四层：成员写必须带 ?scope=public
  const messageResponse = await fetch(`${baseUrl}/api/messages?scope=public`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: sessionCookie,
    },
    body: JSON.stringify({ nickname: "树洞居民", content: "今天天气真好" }),
  });
  assert.equal(messageResponse.status, 201);

  // 成员写封存即便带 reply 也被服务端丢弃（reply 管理员独占）
  const entryResponse = await fetch(`${baseUrl}/api/entries?scope=public`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: sessionCookie,
    },
    body: JSON.stringify({ mood: "平静", content: "把心事封存起来", reply: "试图塞入" }),
  });
  assert.equal(entryResponse.status, 201);

  const messageList = await (
    await fetch(`${baseUrl}/api/messages?scope=public`, {
      headers: { cookie: sessionCookie },
    })
  ).json();
  assert.equal(messageList.items[0].nickname, "树洞居民");
  assert.equal(messageList.items[0].content, "今天天气真好");
  assert.equal(messageList.items[0].scopeKind, "public");

  const entryList = await (
    await fetch(`${baseUrl}/api/entries?scope=public`, {
      headers: { cookie: sessionCookie },
    })
  ).json();
  assert.equal(entryList.items[0].mood, "平静");
  assert.equal(entryList.items[0].content, "把心事封存起来");
  assert.equal(entryList.items[0].reply, ""); // 塞入的 reply 被丢弃

  const adminWrong = await login("/api/admin/unlock", "open-sesame");
  assert.equal(adminWrong.status, 401);

  const adminLogin = await login("/api/admin/unlock", "admin-sesame");
  assert.equal(adminLogin.status, 200);
  const adminCookie = (adminLogin.headers.get("set-cookie") ?? "").split(";")[0];

  // 跨空间聚合：本库仅公共空间 1 条留言 + 1 条封存
  const items = await (
    await fetch(`${baseUrl}/api/admin/items`, { headers: { cookie: adminCookie } })
  ).json();
  assert.equal(items.messages.length, 1);
  assert.equal(items.entries.length, 1);

  // 删除：新接口由 body 带完整 scope（管理员可信方）
  const deleteMessage = await fetch(
    `${baseUrl}/api/messages/${items.messages[0].id}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        scope: { kind: "public", id: "" },
      }),
    },
  );
  assert.equal(deleteMessage.status, 200);

  const deleteEntry = await fetch(
    `${baseUrl}/api/entries/${items.entries[0].id}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        scope: { kind: "public", id: "" },
      }),
    },
  );
  assert.equal(deleteEntry.status, 200);

  const after = await (
    await fetch(`${baseUrl}/api/admin/items`, { headers: { cookie: adminCookie } })
  ).json();
  assert.deepEqual(after.messages, []);
  assert.deepEqual(after.entries, []);

  const logout = await fetch(`${baseUrl}/api/logout`, {
    method: "POST",
    headers: { cookie: sessionCookie },
  });
  assert.equal(logout.status, 200);
  const logoutSetCookie = logout.headers.get("set-cookie") ?? "";
  assert.match(logoutSetCookie, /tree_hole_session=/);
  assert.doesNotMatch(logoutSetCookie, /(?:^|;\s*)Secure(?:;|$)/);
});
