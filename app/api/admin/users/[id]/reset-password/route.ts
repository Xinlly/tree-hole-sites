import {
  hashUserPassword,
  isAdminUnlocked,
} from "../../../../tree-hole-auth";
import {
  errorStatus,
} from "../../../../tree-hole-store";
import { getStore } from "../../../../store/index";

// §6：重置密码（store 内同时 tokenVersion+1 → 旧令牌立即 401）
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAdminUnlocked())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const password = typeof body?.password === "string" ? body.password : "";
    if (password.length < 6) {
      return Response.json({ error: "password too short" }, { status: 400 });
    }
    const account = await getStore().updateUser(id, {
      passwordHash: await hashUserPassword(password),
    });
    return Response.json({
      user: { id: account.id, tokenVersion: account.tokenVersion },
    });
  } catch (error) {
    const mapped = errorStatus(error);
    return Response.json({ error: mapped.message }, { status: mapped.status });
  }
}
