import { isAdminUnlocked } from "../../tree-hole-auth";
import { listEntries, listMessages, toErrorMessage } from "../../tree-hole-store";

export async function GET() {
  if (!(await isAdminUnlocked())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const [entries, messages] = await Promise.all([listEntries(), listMessages()]);
    return Response.json({ entries, messages });
  } catch (error) {
    return Response.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}
