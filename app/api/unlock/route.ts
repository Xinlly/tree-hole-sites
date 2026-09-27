import { getConfiguredPassword, setUnlockedCookie } from "../tree-hole-auth";

export async function POST(request: Request) {
  const configuredPassword = await getConfiguredPassword();
  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";

  if (!configuredPassword || password !== configuredPassword) {
    return Response.json({ ok: false }, { status: 401 });
  }

  await setUnlockedCookie(configuredPassword);
  return Response.json({ ok: true });
}
