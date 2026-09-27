import { createEntry, listEntries, toErrorMessage } from "../tree-hole-store";

export async function GET() {
  try {
    return Response.json({ entries: await listEntries() });
  } catch (error) {
    return Response.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      content?: string;
      mood?: string;
      reply?: string;
    };
    const mood = payload.mood?.trim() ?? "";
    const content = payload.content?.trim() ?? "";
    const reply = payload.reply?.trim() ?? "";

    if (!mood || !content) {
      return Response.json({ error: "mood and content are required" }, { status: 400 });
    }

    await createEntry(mood.slice(0, 24), content.slice(0, 1500), reply.slice(0, 500));
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return Response.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}
