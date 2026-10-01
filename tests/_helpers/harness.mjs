// 公共测试夹具：fake object client（内存 Map）+ ALS 请求 cookie 罐 + handler 调用封装。
// 顶部 import 即完成 next/headers 拦截与无扩展名 .ts 解析。
import { Buffer } from "node:buffer";
import { mockClient } from "aws-sdk-client-mock";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { requestStorage } from "./register-next-mock.mjs";

process.env.STORAGE_TYPE = "object";
process.env.STORAGE_OBJECT_ENDPOINT = "https://example.test";
process.env.STORAGE_OBJECT_REGION = "us-east-1";
process.env.STORAGE_OBJECT_BUCKET = "test-bucket";
process.env.STORAGE_OBJECT_ACCESS_KEY_ID = "k";
process.env.STORAGE_OBJECT_SECRET_ACCESS_KEY = "s";
process.env.TREE_HOLE_PASSWORD = "public-pass";
process.env.TREE_HOLE_ADMIN_PASSWORD = "admin-pass";
process.env.TREE_HOLE_SIGN_SECRET = "unit-test-secret";

export const PUBLIC_PASSWORD = "public-pass";
export const ADMIN_PASSWORD = "admin-pass";
export const ORIGIN = "http://localhost";

// 内存桶：所有测试文件独立进程，本文件内共享
export const bucket = new Map();

const s3Mock = mockClient(S3Client);
s3Mock.on(PutObjectCommand).callsFake(async (input) => {
  bucket.set(input.Key, input.Body);
  return {};
});
s3Mock.on(GetObjectCommand).callsFake(async (input) => {
  if (!bucket.has(input.Key)) {
    const error = new Error("NoSuchKey");
    error.name = "NoSuchKey";
    throw error;
  }
  return { Body: bucket.get(input.Key) };
});
s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
  const prefix = input.Prefix ?? "";
  const startAfter = input.StartAfter ?? "";
  const keys = [...bucket.keys()]
    .filter((key) => key.startsWith(prefix) && key > startAfter)
    .sort();
  return { Contents: keys.map((Key) => ({ Key })) };
});

export function resetBucket() {
  bucket.clear();
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
}

// —— cookie 罐构造 ——

export async function publicJar() {
  const value = await sha256Hex("tree-hole:v1:" + PUBLIC_PASSWORD);
  return new Map([["tree_hole_session", value]]);
}

export async function adminJar() {
  const value = await sha256Hex("tree-hole-admin:v1:" + ADMIN_PASSWORD);
  return new Map([["tree_hole_admin_session", value]]);
}

export async function passJar(passphrase) {
  return new Map([["tree_hole_pass_session", await sha256Hex(passphrase)]]);
}

// §3.4 user session=userId.tokenVersion.expiresAt.sig（expiresAt 为毫秒；复刻签名，测试用固定 secret）
export async function userJar(account, expiresInSeconds = 3600) {
  const userId = account.id;
  const tokenVersion = account.tokenVersion;
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(process.env.TREE_HOLE_SIGN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${userId}:${tokenVersion}:${expiresAt}`),
    ),
  ).toString("base64url");
  return new Map([
    ["tree_hole_user_session", `${userId}.${tokenVersion}.${expiresAt}.${sig}`],
  ]);
}

// —— handler 调用 ——

// invoke(handler, {method, path, jar, body, headers, args}) → Response
// args：作为第二参数传入（[id] 路由传 {params: Promise.resolve({id})}）
export function invoke(
  handler,
  {
    method = "GET",
    path,
    jar = new Map(),
    body = undefined,
    headers = {},
    args = undefined,
  },
) {
  const h = new Headers(headers);
  // 登录类默认同源；需要测跨站时由调用方覆盖
  if (!h.has("origin")) h.set("origin", ORIGIN);
  if (!h.has("sec-fetch-site")) h.set("sec-fetch-site", "same-origin");
  let payload = null;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h.set("content-type", "application/json");
  }
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers: h,
    body: payload,
  });
  const scope = { jar, setCookies: [] };
  return requestStorage.run(scope, () =>
    args === undefined ? handler(request) : handler(request, args),
  );
}

export async function readJson(response) {
  return response.json();
}
