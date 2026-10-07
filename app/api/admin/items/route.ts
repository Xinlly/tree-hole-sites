import { isAdminUnlocked } from "../../tree-hole-auth";
import {
  listAllAcrossScopes,
  toErrorMessage,
} from "../../tree-hole-store";
import { getStore } from "../../store/index";

// §6：跨空间留言+封存（每条自带 scopeKind/scopeId 标注）、口令空间列表
export async function GET() {
  if (!(await isAdminUnlocked())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const [items, passSpaces] = await Promise.all([
      listAllAcrossScopes(),
      getStore().listPassSpaces(),
    ]);
    return Response.json({ ...items, passSpaces });
  } catch (error) {
    return Response.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}
