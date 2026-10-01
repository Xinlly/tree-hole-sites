import {
  createEntry,
  errorStatus,
  listEntries,
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
    return Response.json(await listEntries(auth.scope, options));
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
      mood?: string;
      reply?: string; // §6：成员（及管理员创建）携带的 reply 一律丢弃
    };
    const mood = payload.mood?.trim() ?? "";
    const content = payload.content?.trim() ?? "";

    if (!mood || !content) {
      return Response.json(
        { error: "mood and content are required" },
        { status: 400 },
      );
    }

    // 任何创建都写 reply=""；回复一律走 /api/entries/:id/reply
    await createEntry(auth.scope, mood.slice(0, 24), content.slice(0, 1500));
    if (auth.scope.kind === "pass") {
      await getStore().ensurePassSpace(auth.scope.id);
    }
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return Response.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}
