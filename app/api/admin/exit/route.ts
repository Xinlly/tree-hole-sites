import { clearAdminCookie } from "../../tree-hole-auth";

export async function POST() {
  // 只退管理员会话；公共/口令/个人会话相互独立、保留以便快速切换
  await clearAdminCookie();
  return Response.json({ ok: true });
}
