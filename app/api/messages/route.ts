import {
  createMessage,
  listMessages,
  normalizeNickname,
  parseListQuery,
  toErrorMessage,
} from "../tree-hole-store";

export async function GET(request: Request) {
  try {
    const { options, error } = parseListQuery(new URL(request.url));
    if (error) {
      return Response.json({ error }, { status: 400 });
    }
    return Response.json(await listMessages(options));
  } catch (error) {
    return Response.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      content?: string;
      nickname?: string;
    };
    const content = payload.content?.trim() ?? "";
    if (!content) {
      return Response.json({ error: "content is required" }, { status: 400 });
    }

    await createMessage(normalizeNickname(payload.nickname), content.slice(0, 1000));
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return Response.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}
