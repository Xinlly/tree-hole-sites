import {
  getSessionIdentity,
  isAdminUnlocked,
  isUnlocked,
} from "../tree-hole-auth";

// 前端据此决定显示哪一层入口、顶部空间栏身份摘要；四类会话相互独立
export async function GET() {
  const [publicUnlocked, adminUnlocked, identity] = await Promise.all([
    isUnlocked(),
    isAdminUnlocked(),
    getSessionIdentity(),
  ]);
  return Response.json({
    unlocked: publicUnlocked,
    admin: adminUnlocked,
    passId: identity.passId,
    passLabel: identity.passLabel,
    username: identity.username,
  });
}
