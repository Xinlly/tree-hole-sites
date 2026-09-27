import { isAdminUnlocked } from "../../../tree-hole-auth";
import { deleteMessage, toErrorMessage } from "../../../tree-hole-store";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAdminUnlocked())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    await deleteMessage(Number(id));
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}
