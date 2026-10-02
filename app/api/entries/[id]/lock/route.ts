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
    // 非管理员成员仅在自己的个人空间可锁定/解锁；公共/口令空间锁定仅管理员
    if (auth.member && auth.scope.kind !== "user") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    // 个人空间所有者“解锁”需绕过锁校验；“再锁”仍走锁检查以返回 409
    const bypass = auth.bypassLock
      || (auth.member && auth.scope.kind === "user" && body.locked === false);
    await setEntryLocked(auth.scope, idFromUrl(request), body.locked, {
      bypassLock: bypass,
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
