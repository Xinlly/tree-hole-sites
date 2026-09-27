import { cookies } from "next/headers";

const COOKIE_NAME = "tree_hole_session";
const ADMIN_COOKIE_NAME = "tree_hole_admin_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SESSION_PREFIX = "tree-hole:v1:";
const ADMIN_SESSION_PREFIX = "tree-hole-admin:v1:";

export async function getConfiguredPassword() {
  return process.env.TREE_HOLE_PASSWORD ?? "";
}

export async function getConfiguredAdminPassword() {
  return process.env.TREE_HOLE_ADMIN_PASSWORD ?? process.env.TREE_HOLE_PASSWORD ?? "";
}

export async function createSessionValue(password: string) {
  return sha256(`${SESSION_PREFIX}${password}`);
}

export async function createAdminSessionValue(password: string) {
  return sha256(`${ADMIN_SESSION_PREFIX}${password}`);
}

export async function isUnlocked() {
  const password = await getConfiguredPassword();
  if (!password) return false;

  const cookieStore = await cookies();
  const actual = cookieStore.get(COOKIE_NAME)?.value ?? "";
  const expected = await createSessionValue(password);
  return actual === expected;
}

export async function isAdminUnlocked() {
  const password = await getConfiguredAdminPassword();
  if (!password) return false;

  const cookieStore = await cookies();
  const actual = cookieStore.get(ADMIN_COOKIE_NAME)?.value ?? "";
  const expected = await createAdminSessionValue(password);
  return actual === expected;
}

export async function setUnlockedCookie(password: string) {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, await createSessionValue(password), {
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
}

export async function setAdminUnlockedCookie(password: string) {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE_NAME, await createAdminSessionValue(password), {
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
}

export async function clearUnlockedCookie() {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
  cookieStore.set(ADMIN_COOKIE_NAME, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
