import { clearUnlockedCookie } from "../tree-hole-auth";

export async function POST() {
  await clearUnlockedCookie();
  return Response.json({ ok: true });
}
