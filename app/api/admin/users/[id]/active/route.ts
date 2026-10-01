import {
  isAdminUnlocked,
} from "../../../../tree-hole-auth";
import {
  errorStatus,
} from "../../../../tree-hole-store";
import { getStore } from "../../../../store/index";

// §6：启停账号（停用即旧令牌 401；重新启用不 bump，停用前令牌恢复）
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
    if (typeof body?.active !== "boolean") {
      return Response.json({ error: "active must be boolean" }, { status: 400 });
    }
    const account = await getStore().updateUser(id, { active: body.active });
    return Response.json({
      user: { id: account.id, active: account.active },
    });
  } catch (error) {
    const mapped = errorStatus(error);
    return Response.json({ error: mapped.message }, { status: mapped.status });
  }
}
