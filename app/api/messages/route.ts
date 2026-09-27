import {
  createMessage,
  listMessages,
  normalizeNickname,
  toErrorMessage,
} from "../tree-hole-store";

export async function GET() {
  try {
    return Response.json({ messages: await listMessages() });
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
