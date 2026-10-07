import { clearPublicCookie } from "../tree-hole-auth";

export async function POST() {
  // §3.2：只退公共空间会话；口令/个人/管理员会话相互独立、保留以便快速切换
  await clearPublicCookie();
  return Response.json({ ok: true });
}
