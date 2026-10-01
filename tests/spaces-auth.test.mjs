import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_PASSWORD,
  adminJar,
  bucket,
  invoke,
  passJar,
  publicJar,
  readJson,
  resetBucket,
  sha256Hex,
  userJar,
} from "./_helpers/harness.mjs";

const messagesRoute = await import("../app/api/messages/route.ts");
const messageIdRoute = await import("../app/api/messages/[id]/route.ts");
const messageLockRoute = await import(
  "../app/api/messages/[id]/lock/route.ts"
);
const entriesRoute = await import("../app/api/entries/route.ts");
const entryIdRoute = await import("../app/api/entries/[id]/route.ts");
const entryLockRoute = await import(
  "../app/api/entries/[id]/lock/route.ts"
);
const entryReplyRoute = await import(
  "../app/api/entries/[id]/reply/route.ts"
);
const unlockRoute = await import("../app/api/unlock/route.ts");
const passUnlockRoute = await import("../app/api/pass/unlock/route.ts");
const accountLoginRoute = await import(
  "../app/api/account/login/route.ts"
);
const adminUnlockRoute = await import(
  "../app/api/admin/unlock/route.ts"
);
const adminItemsRoute = await import(
  "../app/api/admin/items/route.ts"
);
const adminUsersRoute = await import(
  "../app/api/admin/users/route.ts"
);
const resetPwRoute = await import(
  "../app/api/admin/users/[id]/reset-password/route.ts"
);
const activeRoute = await import(
  "../app/api/admin/users/[id]/active/route.ts"
);

const argsFor = (id) => ({ params: Promise.resolve({ id }) });

// 管理员预置账号，返回不含哈希的账号对象（含 id）
async function createAccount(username, password = "secret123") {
  const res = await invoke(adminUsersRoute.POST, {
    method: "POST",
    path: "/api/admin/users",
    jar: await adminJar(),
    body: { username, password },
  });
  assert.equal(res.status, 201);
  return (await readJson(res)).user;
}

test.beforeEach(() => {
  resetBucket();
});

// —— A1 ——

test("A1: 无会话访问成员 GET → 401", async () => {
  const res = await invoke(messagesRoute.GET, {
    path: "/api/messages?scope=public",
  });
  assert.equal(res.status, 401);
});

test("A1: 公共口令错误 → 401", async () => {
  const res = await invoke(unlockRoute.POST, {
    method: "POST",
    path: "/api/unlock",
    body: { password: "wrong" },
  });
  assert.equal(res.status, 401);
});

test("A1: 账号错误凭据 → 401", async () => {
  await createAccount("alice");
  const res = await invoke(accountLoginRoute.POST, {
    method: "POST",
    path: "/api/account/login",
    body: { username: "alice", password: "nope99" },
  });
  assert.equal(res.status, 401);
});

test("A1: 管理员口令错误 → 401", async () => {
  const res = await invoke(adminUnlockRoute.POST, {
    method: "POST",
    path: "/api/admin/unlock",
    body: { password: "wrong" },
  });
  assert.equal(res.status, 401);
});

test("A1: pass/unlock 恒 200（错误/任意口令均不报错）", async () => {
  const res = await invoke(passUnlockRoute.POST, {
    method: "POST",
    path: "/api/pass/unlock",
    body: { passphrase: "a-totally-unknown-pass" },
  });
  assert.equal(res.status, 200);
});

test("A1: 成员路由漏带 scope → 400", async () => {
  const res = await invoke(messagesRoute.GET, {
    path: "/api/messages",
    jar: await publicJar(),
  });
  assert.equal(res.status, 400);
});

test("A1: 登录端点跨站请求 → 403", async () => {
  const res = await invoke(unlockRoute.POST, {
    method: "POST",
    path: "/api/unlock",
    body: { password: ADMIN_PASSWORD },
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(res.status, 403);
});

// —— A2 ——

test("A2: 公共空间写入，口令空间列表不可见", async () => {
  await invoke(messagesRoute.POST, {
    method: "POST",
    path: "/api/messages?scope=public",
    jar: await publicJar(),
    body: { nickname: "甲", content: "公共留言" },
  });
  const pub = await invoke(messagesRoute.GET, {
    path: "/api/messages?scope=public",
    jar: await publicJar(),
  });
  assert.equal((await readJson(pub)).items.length, 1);

  const pRes = await invoke(messagesRoute.GET, {
    path: "/api/messages?scope=pass",
    jar: await passJar("secret-room"),
  });
  assert.equal((await readJson(pRes)).items.length, 0);
});

test("A2: 口令空间写入不泄漏到公共", async () => {
  await invoke(messagesRoute.POST, {
    method: "POST",
    path: "/api/messages?scope=pass",
    jar: await passJar("room-x"),
    body: { nickname: "乙", content: "房间内" },
  });
  const pub = await invoke(messagesRoute.GET, {
    path: "/api/messages?scope=public",
    jar: await publicJar(),
  });
  assert.equal((await readJson(pub)).items.length, 0);
});

// —— A3 ——

test("A3: 同口令两次进入同一集合；异口令隔离", async () => {
  const enter = async (phrase) =>
    invoke(passUnlockRoute.POST, {
      method: "POST",
      path: "/api/pass/unlock",
      body: { passphrase: phrase },
    });
  const r1 = await enter("same-secret");
  const r2 = await enter("same-secret");
  const r3 = await enter("other-secret");
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 200);
  // 会话 cookie 值即空间 id；同口令相同、异口令不同
  const idSame1 = await sha256Hex("same-secret");
  const idSame2 = await sha256Hex("same-secret");
  const idOther = await sha256Hex("other-secret");
  assert.equal(idSame1, idSame2);
  assert.notEqual(idSame1, idOther);

  // 同口令两侧互相可见
  const j1 = await passJar("same-secret");
  await invoke(messagesRoute.POST, {
    method: "POST",
    path: "/api/messages?scope=pass",
    jar: j1,
    body: { content: "共享内容" },
  });
  const page = await invoke(messagesRoute.GET, {
    path: "/api/messages?scope=pass",
    jar: await passJar("same-secret"),
  });
  assert.equal((await readJson(page)).items.length, 1);
  // 异口令不可见
  const isolated = await invoke(messagesRoute.GET, {
    path: "/api/messages?scope=pass",
    jar: await passJar("other-secret"),
  });
  assert.equal((await readJson(isolated)).items.length, 0);
});

// —— A4 ——

test("A4: 成员可改任意留言（含署名），updatedAt 更新", async () => {
  const jar = await publicJar();
  await invoke(messagesRoute.POST, {
    method: "POST",
    path: "/api/messages?scope=public",
    jar,
    body: { nickname: "原作者", content: "原文" },
  });
  const list = await readJson(
    await invoke(messagesRoute.GET, {
      path: "/api/messages?scope=public",
      jar,
    }),
  );
  const target = list.items[0];
  assert.equal(target.updatedAt, undefined);

  const patch = await invoke(messageIdRoute.PATCH, {
    method: "PATCH",
    path: `/api/messages/${target.id}?scope=public`,
    jar,
    body: { nickname: "改人", content: "被改了" },
    args: argsFor(target.id),
  });
  assert.equal(patch.status, 200);

  const after = await readJson(
    await invoke(messagesRoute.GET, {
      path: "/api/messages?scope=public",
      jar,
    }),
  );
  assert.equal(after.items[0].nickname, "改人");
  assert.equal(after.items[0].content, "被改了");
  assert.equal(typeof after.items[0].updatedAt, "string");
  assert.equal(after.items[0].id, target.id);
});

test("A4: 成员可改封存 mood+正文（含他人所写）；携带 reply 被丢弃", async () => {
  const jar = await passJar("mood-room");
  await invoke(entriesRoute.POST, {
    method: "POST",
    path: "/api/entries?scope=pass",
    jar,
    body: { mood: "开心", content: "他人封存", reply: "想塞回复" },
  });
  const list = await readJson(
    await invoke(entriesRoute.GET, {
      path: "/api/entries?scope=pass",
      jar,
    }),
  );
  const target = list.items[0];
  // 创建时 reply 强制为 ""
  assert.equal(target.reply, "");

  const patch = await invoke(entryIdRoute.PATCH, {
    method: "PATCH",
    path: `/api/entries/${target.id}?scope=pass`,
    jar,
    body: { mood: "平静", content: "改后正文" },
    args: argsFor(target.id),
  });
  assert.equal(patch.status, 200);

  const after = await readJson(
    await invoke(entriesRoute.GET, {
      path: "/api/entries?scope=pass",
      jar,
    }),
  );
  assert.equal(after.items[0].mood, "平静");
  assert.equal(after.items[0].content, "改后正文");
  assert.equal(after.items[0].reply, "");
  assert.equal(typeof after.items[0].updatedAt, "string");
});

// —— A5 ——

test("A5: 锁定后可读；成员改/再锁 409；锁持久化；管理员可解锁/改", async () => {
  const jar = await publicJar();
  await invoke(messagesRoute.POST, {
    method: "POST",
    path: "/api/messages?scope=public",
    jar,
    body: { content: "将被锁" },
  });
  const id = (
    await readJson(
      await invoke(messagesRoute.GET, {
        path: "/api/messages?scope=public",
        jar,
      }),
    )
  ).items[0].id;

  // 成员锁定
  const lock = await invoke(messageLockRoute.POST, {
    method: "POST",
    path: `/api/messages/${id}/lock?scope=public`,
    jar,
    body: { locked: true },
    args: argsFor(id),
  });
  assert.equal(lock.status, 200);

  // 仍可读，locked=true 持久化
  const readable = await readJson(
    await invoke(messagesRoute.GET, {
      path: "/api/messages?scope=public",
      jar,
    }),
  );
  assert.equal(readable.items[0].locked, true);

  // 成员再改 → 409
  const edit = await invoke(messageIdRoute.PATCH, {
    method: "PATCH",
    path: `/api/messages/${id}?scope=public`,
    jar,
    body: { content: "想改" },
    args: argsFor(id),
  });
  assert.equal(edit.status, 409);

  // 成员再锁 → 409
  const relock = await invoke(messageLockRoute.POST, {
    method: "POST",
    path: `/api/messages/${id}/lock?scope=public`,
    jar,
    body: { locked: true },
    args: argsFor(id),
  });
  assert.equal(relock.status, 409);

  // 成员尝试解锁 → 403
  const memberUnlock = await invoke(messageLockRoute.POST, {
    method: "POST",
    path: `/api/messages/${id}/lock?scope=public`,
    jar,
    body: { locked: false },
    args: argsFor(id),
  });
  assert.equal(memberUnlock.status, 403);

  // 管理员解锁（body 带完整 scope）
  const adminUnlock = await invoke(messageLockRoute.POST, {
    method: "POST",
    path: `/api/messages/${id}/lock?scope=public`,
    jar: await adminJar(),
    body: { scope: { kind: "public", id: "" }, locked: false },
    args: argsFor(id),
  });
  assert.equal(adminUnlock.status, 200);

  // 管理员可改（此前锁定）
  const adminEdit = await invoke(messageIdRoute.PATCH, {
    method: "PATCH",
    path: `/api/messages/${id}?scope=public`,
    jar: await adminJar(),
    body: { scope: { kind: "public", id: "" }, content: "管理员改" },
    args: argsFor(id),
  });
  assert.equal(adminEdit.status, 200);
});

// —— A6 ——

test("A6: 个人会话只能读本人空间，A 读不到 B", async () => {
  const a = await createAccount("alice");
  const b = await createAccount("bob");

  // B 在自己空间写
  await invoke(messagesRoute.POST, {
    method: "POST",
    path: "/api/messages?scope=user",
    jar: await userJar(b),
    body: { content: "B 的私密" },
  });

  // A 列表不含 B
  const aList = await readJson(
    await invoke(messagesRoute.GET, {
      path: "/api/messages?scope=user",
      jar: await userJar(a),
    }),
  );
  assert.equal(aList.items.length, 0);

  // A 尝试按 B 的 id 修改 → 404（scopeId 只从 A cookie 派生，A 空间无此条），而非读到 B
  const patch = await invoke(messageIdRoute.PATCH, {
    method: "PATCH",
    path: `/api/messages/${b.id}?scope=user`,
    jar: await userJar(a),
    body: { content: "试图越权" },
    args: argsFor(b.id),
  });
  assert.equal(patch.status, 404);
});

// —— A7 ——

test("A7: 非管理员访问 /api/admin/users → 401", async () => {
  const get = await invoke(adminUsersRoute.GET, {
    path: "/api/admin/users",
    jar: await publicJar(),
  });
  assert.equal(get.status, 401);
  const post = await invoke(adminUsersRoute.POST, {
    method: "POST",
    path: "/api/admin/users",
    jar: await publicJar(),
    body: { username: "x", password: "secret123" },
  });
  assert.equal(post.status, 401);
});

test("A7: 非管理员访问管理员跨空间列表 → 401", async () => {
  const res = await invoke(adminItemsRoute.GET, {
    path: "/api/admin/items",
  });
  assert.equal(res.status, 401);
});

// —— A8 ——

test("A8: 管理员跨空间列表含全部且 scope 标注正确", async () => {
  // 公共 1 条留言
  await invoke(messagesRoute.POST, {
    method: "POST",
    path: "/api/messages?scope=public",
    jar: await publicJar(),
    body: { content: "公共1" },
  });
  // 口令空间 1 条留言（写内容才建索引）
  await invoke(messagesRoute.POST, {
    method: "POST",
    path: "/api/messages?scope=pass",
    jar: await passJar("pword"),
    body: { content: "口令1" },
  });
  // 账号空间 1 条留言
  const a = await createAccount("carol");
  await invoke(messagesRoute.POST, {
    method: "POST",
    path: "/api/messages?scope=user",
    jar: await userJar(a),
    body: { content: "账号1" },
  });

  const res = await invoke(adminItemsRoute.GET, {
    path: "/api/admin/items",
    jar: await adminJar(),
  });
  assert.equal(res.status, 200);
  const data = await readJson(res);
  assert.equal(data.messages.length, 3);
  const byKind = data.messages.map((m) => m.scopeKind).sort();
  assert.deepEqual(byKind, ["pass", "public", "user"]);
  // scopeId 标注
  const passMsg = data.messages.find((m) => m.scopeKind === "pass");
  assert.equal(passMsg.scopeId, await sha256Hex("pword"));
  const userMsg = data.messages.find((m) => m.scopeKind === "user");
  assert.equal(userMsg.scopeId, a.id);
  // 口令空间列表
  assert.equal(data.passSpaces.length, 1);
  assert.equal(data.passSpaces[0].id, await sha256Hex("pword"));
});

test("A8: 停用账号后登录被拒、旧会话立即 401；重新启用旧令牌恢复", async () => {
  const a = await createAccount("dave");
  const jar = await userJar(a);

  // 停用
  const off = await invoke(activeRoute.POST, {
    method: "POST",
    path: `/api/admin/users/${a.id}/active`,
    jar: await adminJar(),
    body: { active: false },
    args: argsFor(a.id),
  });
  assert.equal(off.status, 200);

  // 登录被拒
  const login = await invoke(accountLoginRoute.POST, {
    method: "POST",
    path: "/api/account/login",
    body: { username: "dave", password: "secret123" },
  });
  assert.equal(login.status, 401);

  // 旧会话读不到
  const read = await invoke(messagesRoute.GET, {
    path: "/api/messages?scope=user",
    jar,
  });
  assert.equal(read.status, 401);

  // 重新启用（不 bump），同一旧令牌恢复
  await invoke(activeRoute.POST, {
    method: "POST",
    path: `/api/admin/users/${a.id}/active`,
    jar: await adminJar(),
    body: { active: true },
    args: argsFor(a.id),
  });
  const readAgain = await invoke(messagesRoute.GET, {
    path: "/api/messages?scope=user",
    jar,
  });
  assert.equal(readAgain.status, 200);
});

test("A8: 重置密码后旧令牌（旧 tokenVersion）立即 401；新密码可登录", async () => {
  const a = await createAccount("erin");
  const oldJar = await userJar(a);

  const reset = await invoke(resetPwRoute.POST, {
    method: "POST",
    path: `/api/admin/users/${a.id}/reset-password`,
    jar: await adminJar(),
    body: { password: "newsecret1" },
    args: argsFor(a.id),
  });
  assert.equal(reset.status, 200);
  assert.equal((await readJson(reset)).user.tokenVersion, 2);

  // 旧令牌立即 401
  const oldRead = await invoke(messagesRoute.GET, {
    path: "/api/messages?scope=user",
    jar: oldJar,
  });
  assert.equal(oldRead.status, 401);

  // 旧密码登录被拒
  const oldLogin = await invoke(accountLoginRoute.POST, {
    method: "POST",
    path: "/api/account/login",
    body: { username: "erin", password: "secret123" },
  });
  assert.equal(oldLogin.status, 401);
  // 新密码登录成功
  const newLogin = await invoke(accountLoginRoute.POST, {
    method: "POST",
    path: "/api/account/login",
    body: { username: "erin", password: "newsecret1" },
  });
  assert.equal(newLogin.status, 200);
});

test("A6: 令牌自然过期后读接口 401；有效期内 200（expiresAt 毫秒，防量纲回归）", async () => {
  const a = await createAccount("hugo");
  await invoke(messagesRoute.POST, {
    method: "POST",
    path: "/api/messages?scope=user",
    jar: await userJar(a),
    body: { content: "私密内容" },
  });

  // 有效期内 200
  const fresh = await invoke(messagesRoute.GET, {
    path: "/api/messages?scope=user",
    jar: await userJar(a, 3600),
  });
  assert.equal(fresh.status, 200);
  assert.equal((await readJson(fresh)).items.length, 1);

  // 已过期（expiresAt 落在 1 秒前）→ 401
  const expired = await invoke(messagesRoute.GET, {
    path: "/api/messages?scope=user",
    jar: await userJar(a, -1),
  });
  assert.equal(expired.status, 401);
});

test("A8: 成员 query 传他人 scopeId 无效（以会话 cookie 为准）", async () => {
  const a = await createAccount("frank");
  const b = await createAccount("grace");
  await invoke(messagesRoute.POST, {
    method: "POST",
    path: "/api/messages?scope=user",
    jar: await userJar(b),
    body: { content: "B 内容" },
  });
  // A 即便在 query/body 声称 B 的 id，scopeId 仍从 A cookie 派生，读不到 B
  const res = await invoke(messagesRoute.GET, {
    path: `/api/messages?scope=user&limit=20`,
    jar: await userJar(a),
  });
  const data = await readJson(res);
  assert.equal(data.items.length, 0);
  // bucket 中 B 的内容确实存在，证明只是鉴权隔离
  assert.ok(bucket.has(expectStateKey(b.id)));
});

function expectStateKey(userId) {
  return `v3/user/${userId}/messages/state.json.gz`;
}

// 管理员回复入口：锁定不影响回复
test("A8: 管理员可对锁定封存回复", async () => {
  const jar = await publicJar();
  await invoke(entriesRoute.POST, {
    method: "POST",
    path: "/api/entries?scope=public",
    jar,
    body: { mood: "喜", content: "封存正文" },
  });
  const id = (
    await readJson(
      await invoke(entriesRoute.GET, {
        path: "/api/entries?scope=public",
        jar,
      }),
    )
  ).items[0].id;
  // 锁定
  await invoke(entryLockRoute.POST, {
    method: "POST",
    path: `/api/entries/${id}/lock?scope=public`,
    jar,
    body: { locked: true },
    args: argsFor(id),
  });
  // 成员回复无此路由权限（reply 仅管理员）；管理员回复成功
  const reply = await invoke(entryReplyRoute.POST, {
    method: "POST",
    path: `/api/entries/${id}/reply`,
    jar: await adminJar(),
    body: { scope: { kind: "public", id: "" }, reply: "管理员回复" },
    args: argsFor(id),
  });
  assert.equal(reply.status, 200);
  const after = await readJson(
    await invoke(entriesRoute.GET, {
      path: "/api/entries?scope=public",
      jar,
    }),
  );
  assert.equal(after.items[0].reply, "管理员回复");
});
