import {
  isAdminUnlocked,
  isUnlocked,
} from "../tree-hole-auth";

// 前端据此决定显示哪一层入口；四类会话相互独立
export async function GET() {
  const [publicUnlocked, adminUnlocked] = await Promise.all([
    isUnlocked(),
    isAdminUnlocked(),
  ]);
  return Response.json({
    unlocked: publicUnlocked,
    admin: adminUnlocked,
  });
}
