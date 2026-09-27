import {
  getConfiguredAdminPassword,
  setAdminUnlockedCookie,
} from "../../tree-hole-auth";

export async function POST(request: Request) {
  const configuredPassword = await getConfiguredAdminPassword();
  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";

  if (!configuredPassword || password !== configuredPassword) {
    return Response.json({ ok: false }, { status: 401 });
  }

  await setAdminUnlockedCookie(configuredPassword);
  return Response.json({ ok: true });
}
