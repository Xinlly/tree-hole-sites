import { clearAllCookies } from "../tree-hole-auth";

export async function POST() {
  await clearAllCookies();
  return Response.json({ ok: true });
}
