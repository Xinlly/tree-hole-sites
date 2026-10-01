import {
  assertSameOrigin,
  hashUserPassword,
  setUserSessionCookie,
} from "../../tree-hole-auth";
import { getStore } from "../../store/index";

// §3.4：{username,password} → 校验账号与口令哈希 → 置签名 user 会话；失败 401
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) {
    return Response.json({ ok: false }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !password) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const users = await getStore().listUsers();
  const account = users.find(
    (user) => user.username.toLowerCase() === username.toLowerCase(),
  );
  const passwordHash = await hashUserPassword(password);
  if (!account || !account.active || account.passwordHash !== passwordHash) {
    return Response.json({ ok: false }, { status: 401 });
  }

  await setUserSessionCookie(account);
  return Response.json({ ok: true });
}
