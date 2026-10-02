import {
  deleteMessage,
  errorStatus,
  updateMessage,
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
      nickname?: string;
      content?: string;
      scope?: unknown;
    };
    const { id } = await params;
    const auth = await authorizeScopedMutation(request, body);
    if (!auth.ok) {
      return Response.json({ error: auth.error }, { status: auth.status });
    }

    const patch: { nickname?: string; content?: string } = {};
    if (typeof body.nickname === "string") {
      patch.nickname = normalizeNicknameValue(body.nickname);
    }
    if (typeof body.content === "string") {
      const content = body.content.trim();
      if (!content) {
        return Response.json(
          { error: "content is required" },
          { status: 400 },
        );
      }
      patch.content = content.slice(0, 1000);
    }
    if (patch.nickname === undefined && patch.content === undefined) {
      return Response.json({ error: "nothing to update" }, { status: 400 });
    }
    await updateMessage(auth.scope, id, patch, {
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

// §6：仅管理员；body 完整 scope，不全桶扫描
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
    await deleteMessage(auth.scope, id);
    return Response.json({ ok: true });
  } catch (error) {
    const mapped = errorStatus(error);
    return Response.json(
      { error: mapped.message },
      { status: mapped.status },
    );
  }
}

function normalizeNicknameValue(value: string) {
  const nickname = value.trim();
  return nickname ? nickname.slice(0, 24) : "匿名";
}
