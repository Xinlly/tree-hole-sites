import {
  hashUserPassword,
  isAdminUnlocked,
} from "../../tree-hole-auth";
import {
  errorStatus,
} from "../../tree-hole-store";
import { getStore } from "../../store/index";
import type { StoredAccount } from "../../store/types";

// §6：开通账号（不开放注册；仅此管理员入口）
export async function POST(request: Request) {
  if (!(await isAdminUnlocked())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => null);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    const validation = validateCredentials(username, password);
    if (validation) {
      return Response.json({ error: validation }, { status: 400 });
    }

    const account = await getStore().createUser(
      username,
      await hashUserPassword(password),
    );
    // 不回传哈希
    return Response.json({ user: withoutHash(account) }, { status: 201 });
  } catch (error) {
    const mapped = errorStatus(error);
    return Response.json({ error: mapped.message }, { status: mapped.status });
  }
}

// §6：列账号（不含哈希）
export async function GET() {
  if (!(await isAdminUnlocked())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const users = await getStore().listUsers();
  return Response.json({ users: users.map(withoutHash) });
}

// §4.4：username 1–32 字符合集；密码 ≥6（文件内本地函数，非路由导出）
function validateCredentials(username: string, password: string): string | null {
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(username)) {
    return "invalid username";
  }
  if (password.length < 6) {
    return "password too short";
  }
  return null;
}

function withoutHash(account: StoredAccount) {
  return {
    id: account.id,
    username: account.username,
    active: account.active,
    tokenVersion: account.tokenVersion,
    createdAt: account.createdAt,
  };
}
