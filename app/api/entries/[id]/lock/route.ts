import {
  errorStatus,
  setEntryLocked,
} from "../../../tree-hole-store";
import {
  authorizeLock,
} from "../../../tree-hole-auth";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as {
      scope?: unknown;
      locked?: unknown;
    };
    const auth = await authorizeLock(request, body);
    if (!auth.ok) {
      return Response.json({ error: auth.error }, { status: auth.status });
    }
    if (typeof body.locked !== "boolean") {
      return Response.json({ error: "locked must be boolean" }, { status: 400 });
    }
    if (auth.member && body.locked === false) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    await setEntryLocked(auth.scope, idFromUrl(request), body.locked, {
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

function idFromUrl(request: Request): string {
  const parts = new URL(request.url).pathname.split("/");
  return parts[parts.length - 2] ?? "";
}
