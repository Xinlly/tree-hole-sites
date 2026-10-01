import { clearUserCookie } from "../../tree-hole-auth";

export async function POST() {
  await clearUserCookie();
  return Response.json({ ok: true });
}
