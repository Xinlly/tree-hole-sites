import { clearPassCookie } from "../../tree-hole-auth";

export async function POST() {
  await clearPassCookie();
  return Response.json({ ok: true });
}
