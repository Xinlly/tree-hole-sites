import {
  deleteEntry,
  errorStatus,
  updateEntry,
} from "../../tree-hole-store";
import {
  authorizeDelete,
  authorizeScopedMutation,
} from "../../tree-hole-auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = await request.json().catch(() => null) as {
      mood?: string;
      content?: string;
      scope?: unknown;
    };
    const { id } = await params;
    const auth = await authorizeScopedMutation(request, body);
    if (!auth.ok) {
      return Response.json({ error: auth.error }, { status: auth.status });
    }

    const patch: { mood?: string; content?: string } = {};
    if (typeof body.mood === "string") {
      patch.mood = body.mood.trim().slice(0, 24);
    }
    if (typeof body.content === "string") {
      const content = body.content.trim();
      if (!content) {
        return Response.json(
          { error: "content is required" },
          { status: 400 },
        );
      }
      patch.content = content.slice(0, 1500);
    }
    if (patch.mood === undefined && patch.content === undefined) {
      return Response.json({ error: "nothing to update" }, { status: 400 });
    }
    if (patch.mood !== undefined && !patch.mood) {
      return Response.json({ error: "mood is required" }, { status: 400 });
    }
    await updateEntry(auth.scope, id, patch, {
      bypassLock: auth.bypassLock,
    });
    return Response.json({ ok: true });
  } catch (error) {
    const mapped = errorStatus(error);
    return Response.json(
      { error: mapped.message },
      { status: mapped.status },
    );
  }
}

// §6：仅管理员；body 完整 scope
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = await request.json().catch(() => null) as { scope?: unknown };
    const auth = await authorizeDelete(request, body);
    if (!auth.ok) {
      return Response.json({ error: auth.error }, { status: auth.status });
    }
    const { id } = await params;
    await deleteEntry(auth.scope, id);
    return Response.json({ ok: true });
  } catch (error) {
    const mapped = errorStatus(error);
    return Response.json(
      { error: mapped.message },
      { status: mapped.status },
    );
  }
}
