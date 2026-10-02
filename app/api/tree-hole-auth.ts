import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getStore } from "./store/index.ts";
import type { Scope, StoredAccount } from "./store/types.ts";

// §3.2 四类 Cookie
const PUBLIC_COOKIE = "tree_hole_session";
const PASS_COOKIE = "tree_hole_pass_session";
const PASS_LABEL_COOKIE = "tree_hole_pass_label";
const USER_COOKIE = "tree_hole_user_session";
const ADMIN_COOKIE = "tree_hole_admin_session";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SESSION_PREFIX = "tree-hole:v1:";
const ADMIN_SESSION_PREFIX = "tree-hole-admin:v1:";
const USER_PASSWORD_PREFIX = "tree-hole-user:v1:";

const PUBLIC_SCOPE: Scope = { kind: "public", id: "" };

export { PUBLIC_COOKIE, PASS_COOKIE, PASS_LABEL_COOKIE, USER_COOKIE, ADMIN_COOKIE };

// —— 口令配置 ——

export async function getConfiguredPassword() {
  return process.env.TREE_HOLE_PASSWORD ?? "";
}

export async function getConfiguredAdminPassword() {
  return process.env.TREE_HOLE_ADMIN_PASSWORD ??
    process.env.TREE_HOLE_PASSWORD ?? "";
}

// —— 公共 / 管理员会话（保留现有机制）——

export async function createSessionValue(password: string) {
  return sha256Hex(`${SESSION_PREFIX}${password}`);
}

export async function createAdminSessionValue(password: string) {
  return sha256Hex(`${ADMIN_SESSION_PREFIX}${password}`);
}

export async function isUnlocked() {
  const password = await getConfiguredPassword();
  if (!password) return false;
  const cookieStore = await cookies();
  const actual = cookieStore.get(PUBLIC_COOKIE)?.value ?? "";
  return actual === await createSessionValue(password);
}

export async function isAdminUnlocked() {
  const password = await getConfiguredAdminPassword();
  if (!password) return false;
  const cookieStore = await cookies();
  const actual = cookieStore.get(ADMIN_COOKIE)?.value ?? "";
  return actual === await createAdminSessionValue(password);
}

export async function setUnlockedCookie(password: string) {
  const cookieStore = await cookies();
  cookieStore.set(PUBLIC_COOKIE, await createSessionValue(password), cookieOptions());
}

export async function setAdminUnlockedCookie(password: string) {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE, await createAdminSessionValue(password), cookieOptions());
}

// —— 口令空间（§3.3）——

export async function passSpaceId(passphrase: string) {
  return sha256Hex(passphrase);
}

// 口令会话 cookie 存 SHA-256 派生 scopeId；另存一个同生命周期的明文标签 cookie，
// 仅用于在顶部空间栏回显“用户认得的那个口令”，退出/切换时一并清除。
export async function setPassSessionCookie(passphrase: string) {
  const cookieStore = await cookies();
  cookieStore.set(PASS_COOKIE, await passSpaceId(passphrase), cookieOptions());
  cookieStore.set(PASS_LABEL_COOKIE, passphrase, cookieOptions());
}

export async function clearPublicCookie() {
  const cookieStore = await cookies();
  cookieStore.set(PUBLIC_COOKIE, "", cookieClearOptions());
}

export async function clearPassCookie() {
  const cookieStore = await cookies();
  cookieStore.set(PASS_COOKIE, "", cookieClearOptions());
  cookieStore.set(PASS_LABEL_COOKIE, "", cookieClearOptions());
}

// 读取当前口令空间的明文标签（建索引时落库用）；无则 null（历史会话）
export async function getPassLabel(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(PASS_LABEL_COOKIE)?.value ?? null;
}

// —— 个人账号：HMAC 签名令牌（§3.4）——

export async function hashUserPassword(password: string) {
  return sha256Hex(`${USER_PASSWORD_PREFIX}${password}`);
}

export async function issueUserToken(account: StoredAccount) {
  const expiresAt = Date.now() + COOKIE_MAX_AGE * 1000;
  const sig = await signToken(account.id, account.tokenVersion, expiresAt);
  return {
    value: `${account.id}.${account.tokenVersion}.${expiresAt}.${sig}`,
    expiresAt,
  };
}

// §3.4 校验：常量时间比签名 → 过期 → 账号 active → tokenVersion 一致
export async function verifyUserToken(token: string): Promise<StoredAccount | null> {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, versionText, expiresText, sig] = parts;
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(userId)) return null;
  const tokenVersion = Number(versionText);
  const expiresAt = Number(expiresText);
  if (!Number.isInteger(tokenVersion) || !Number.isInteger(expiresAt)) {
    return null;
  }
  const expected = await signToken(userId, tokenVersion, expiresAt);
  if (!constantTimeEqual(sig, expected)) return null;
  if (expiresAt <= Date.now()) return null;

  const account = (await getStore().listUsers()).find((user) => user.id === userId);
  if (!account || !account.active) return null;
  if (account.tokenVersion !== tokenVersion) return null;
  return account;
}

async function getCurrentUserAccount(): Promise<StoredAccount | null> {
  const token = (await cookies()).get(USER_COOKIE)?.value;
  if (!token) return null;
  return verifyUserToken(token);
}

export async function setUserSessionCookie(account: StoredAccount) {
  const cookieStore = await cookies();
  const token = await issueUserToken(account);
  cookieStore.set(USER_COOKIE, token.value, cookieOptions());
}

export async function clearUserCookie() {
  const cookieStore = await cookies();
  cookieStore.set(USER_COOKIE, "", cookieClearOptions());
}

export async function clearAdminCookie() {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE, "", cookieClearOptions());
}

// 顶部空间栏身份摘要：口令回显明文标签（用户认得的那个口令），个人给真实用户名。
export async function getSessionIdentity(): Promise<{
  passId: string | null;
  passLabel: string | null;
  username: string | null;
}> {
  const cookieStore = await cookies();
  const passId = cookieStore.get(PASS_COOKIE)?.value ?? null;
  const passLabel = cookieStore.get(PASS_LABEL_COOKIE)?.value ?? null;
  let username: string | null = null;
  const userToken = cookieStore.get(USER_COOKIE)?.value;
  if (userToken) {
    const account = await verifyUserToken(userToken);
    if (account) username = account.username;
  }
  return { passId, passLabel, username };
}

// §3.4：SIGN_SECRET 缺则用管理员口令 SHA-256 派生
async function getSignSecret(): Promise<Uint8Array> {
  const configured = process.env.TREE_HOLE_SIGN_SECRET;
  if (configured) {
    return new TextEncoder().encode(configured);
  }
  const adminPassword = await getConfiguredAdminPassword();
  return new TextEncoder().encode(await sha256Hex(adminPassword));
}

async function signToken(
  userId: string,
  tokenVersion: number,
  expiresAt: number,
): Promise<string> {
  const secret = await getSignSecret();
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `${userId}:${tokenVersion}:${expiresAt}`;
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload) as BufferSource,
  );
  return Buffer.from(digest).toString("base64url");
}

// —— 统一守卫（§3.5）——

export type MemberAuth =
  | { ok: true; scope: Scope; admin: boolean }
  | { ok: false; status: 400 | 401 | 403; error: string };

// write=false=读；write=true=写/改/成员锁定
export async function authorizeMember(
  request: Request,
  write: boolean,
): Promise<MemberAuth> {
  const kindParam = new URL(request.url).searchParams.get("scope");
  if (kindParam !== "public" && kindParam !== "pass" && kindParam !== "user") {
    return { ok: false, status: 400, error: "scope is required" };
  }

  const admin = await isAdminUnlocked();

  if (kindParam === "public") {
    if (await isUnlocked()) {
      return { ok: true, scope: PUBLIC_SCOPE, admin };
    }
    if (admin) {
      return { ok: true, scope: PUBLIC_SCOPE, admin: true };
    }
    return { ok: false, status: 401, error: "unauthorized" };
  }

  if (kindParam === "pass") {
    // scopeId 只从 pass cookie 派生
    const passId = (await cookies()).get(PASS_COOKIE)?.value;
    if (passId && /^[0-9a-f]{64}$/.test(passId)) {
      return { ok: true, scope: { kind: "pass", id: passId }, admin };
    }
    return { ok: false, status: 401, error: "unauthorized" };
  }

  // user
  const account = await getCurrentUserAccount();
  if (account) {
    return { ok: true, scope: { kind: "user", id: account.id }, admin };
  }
  // 已认证为管理员但个人空间写不允许代写；读也无法从 cookie 派生 id
  if (admin && write) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: false, status: 401, error: "unauthorized" };
}

// PATCH 路由（§6：必须 ?scope=；本空间成员/管理员，管理员不受锁限制）。
// 成员路径 scopeId 只从 cookie 派生；管理员兜底从 body.scope 取 id（可信方）。
export async function authorizeScopedMutation(
  request: Request,
  body: { scope?: unknown },
): Promise<
  | { ok: true; scope: Scope; bypassLock: boolean; admin: boolean }
  | { ok: false; status: 400 | 401 | 403; error: string }
> {
  const kindParam = new URL(request.url).searchParams.get("scope");
  if (
    kindParam !== "public" &&
    kindParam !== "pass" &&
    kindParam !== "user"
  ) {
    return { ok: false, status: 400, error: "scope is required" };
  }

  const member = await authorizeMember(request, true);
  if (member.ok) {
    return {
      ok: true,
      scope: member.scope,
      bypassLock: member.admin,
      admin: member.admin,
    };
  }

  if (await isAdminUnlocked()) {
    const scope = parseScope(body.scope);
    if (!scope || scope.kind !== kindParam) {
      return { ok: false, status: 400, error: "scope is required" };
    }
    return { ok: true, scope, bypassLock: true, admin: true };
  }
  return { ok: false, status: member.status, error: member.error };
}

// lock 路由（§6）：
// - 带 ?scope：成员路径（仅可 locked=true；锁定后再锁 409）；管理员可经 body.scope 改 false
// - 不带 ?scope：仅管理员，body 完整 scope + locked 布尔
export async function authorizeLock(
  request: Request,
  body: { scope?: unknown; locked?: unknown },
): Promise<
  | {
      ok: true;
      scope: Scope;
      bypassLock: boolean;
      member: boolean;
    }
  | { ok: false; status: 400 | 401 | 403; error: string }
> {
  const hasScopeParam = new URL(request.url).searchParams.has("scope");
  if (!hasScopeParam) {
    const admin = await authorizeAdminWithScope(body);
    if (!admin.ok) return admin;
    return { ok: true, scope: admin.scope, bypassLock: true, member: false };
  }
  const auth = await authorizeScopedMutation(request, body);
  if (!auth.ok) return auth;
  // member 仅“非管理员”；管理员带 ?scope 仍可解锁
  return {
    ok: true,
    scope: auth.scope,
    bypassLock: auth.bypassLock,
    member: !auth.admin,
  };
}

// 管理员 :id 路由：仅管理员，body 必须带完整 scope
export async function authorizeAdminWithScope(
  body: { scope?: unknown },
): Promise<
  | { ok: true; scope: Scope }
  | { ok: false; status: 400 | 401; error: string }
> {
  if (!(await isAdminUnlocked())) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  const scope = parseScope(body.scope);
  if (!scope) {
    return { ok: false, status: 400, error: "scope is required" };
  }
  return { ok: true, scope };
}

export function parseScope(value: unknown): Scope | null {
  if (typeof value !== "object" || value === null) return null;
  const scope = value as { kind?: unknown; id?: unknown };
  if (scope.kind === "public" && scope.id === "") {
    return { kind: "public", id: "" };
  }
  if (scope.kind === "pass" && typeof scope.id === "string" &&
    /^[0-9a-f]{64}$/.test(scope.id)) {
    return { kind: "pass", id: scope.id };
  }
  if (scope.kind === "user" && typeof scope.id === "string" &&
    /^[0-9A-HJKMNP-TV-Z]{26}$/.test(scope.id)) {
    return { kind: "user", id: scope.id };
  }
  return null;
}

// —— 登录类端点 login-CSRF（§12）——

export function assertSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return false;
  }
  const origin = request.headers.get("origin");
  if (origin) {
    // 反代后 request.url 可能是内部监听地址（如 http://0.0.0.0:3000），
    // 不能直接拿它比浏览器 Origin；优先用对外可见的 Host/X-Forwarded-* 推导期望源，
    // 都缺失时（如单测/简单直连）才回退到 request.url。
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
    const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim()
      ?? request.headers.get("host");
    let expectedOrigin;
    try {
      expectedOrigin = host
        ? new URL(`${proto ?? "http"}://${host}`).origin
        : new URL(request.url).origin;
    } catch {
      return false;
    }
    let actualOrigin;
    try {
      actualOrigin = new URL(origin).origin;
    } catch {
      return false;
    }
    if (actualOrigin !== expectedOrigin) return false;
  }
  return true;
}

// —— 工具 ——

function cookieOptions() {
  return {
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    path: "/",
    sameSite: "lax" as const,
    secure: false,
  };
}

function cookieClearOptions() {
  return {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax" as const,
    secure: false,
  };
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Buffer.from(value, "utf8"),
  );
  return Buffer.from(digest).toString("hex");
}

function constantTimeEqual(a: string, b: string) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
