import {
  errorStatus,
  setEntryReply,
} from "../../../tree-hole-store";
import {
  authorizeAdminWithScope,
} from "../../../tree-hole-auth";

// §6：管理员独占；body 完整 scope + reply；锁定不影响回复
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as {
      scope?: unknown;
      reply?: unknown;
    };
    const auth = await authorizeAdminWithScope(body);
    if (!auth.ok) {
      return Response.json({ error: auth.error }, { status: auth.status });
    }
    if (typeof body.reply !== "string") {
      return Response.json({ error: "reply must be string" }, { status: 400 });
    }
    const id = idFromUrl(request);
    await setEntryReply(auth.scope, id, body.reply.trim().slice(0, 500));
    return Response.json({ ok: true });
  } catch (error) {
    const mapped = errorStatus(error);
    return Response.json(
      { error: mapped.message },
      { status: mapped.status },
    );
  }
}

function idFromUrl(request: Request): string {
  const parts = new URL(request.url).pathname.split("/");
  return parts[parts.length - 2] ?? "";
}
