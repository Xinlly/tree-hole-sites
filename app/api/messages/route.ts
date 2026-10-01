import {
  createMessage,
  errorStatus,
  listMessages,
  normalizeNickname,
  parseListQuery,
  toErrorMessage,
} from "../tree-hole-store";
import {
  authorizeMember,
} from "../tree-hole-auth";
import { getStore } from "../store/index";

export async function GET(request: Request) {
  try {
    const auth = await authorizeMember(request, false);
    if (!auth.ok) {
      return Response.json({ error: auth.error }, { status: auth.status });
    }
    const { options, error } = parseListQuery(new URL(request.url));
    if (error) {
      return Response.json({ error }, { status: 400 });
    }
    return Response.json(await listMessages(auth.scope, options));
  } catch (error) {
    const mapped = errorStatus(error);
    return Response.json(
      { error: mapped.message },
      { status: mapped.status },
    );
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authorizeMember(request, true);
    if (!auth.ok) {
      return Response.json({ error: auth.error }, { status: auth.status });
    }
    const payload = (await request.json()) as {
      content?: string;
      nickname?: string;
    };
    const content = payload.content?.trim() ?? "";
    if (!content) {
      return Response.json({ error: "content is required" }, { status: 400 });
    }

    await createMessage(
      auth.scope,
      normalizeNickname(payload.nickname),
      content.slice(0, 1000),
    );
    // §4.3：口令空间第一条内容写入时建立索引（幂等）
    if (auth.scope.kind === "pass") {
      await getStore().ensurePassSpace(auth.scope.id);
    }
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return Response.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}
