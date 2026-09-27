import { isUnlocked } from "../tree-hole-auth";

export async function GET() {
  return Response.json({ unlocked: await isUnlocked() });
}
