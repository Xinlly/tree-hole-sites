import assert from "node:assert/strict";
import test from "node:test";

// 顶部夹具完成 .ts 解析（不依赖其 bucket）
import "./_helpers/harness.mjs";

const { assertSameOrigin } = await import(
  "../app/api/tree-hole-auth.ts"
);

function make(url, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin", ...headers },
  });
}

test("反代：Origin 匹配 X-Forwarded-Host，即使 request.url 是内部 0.0.0.0:3000 → true", () => {
  const req = make("http://0.0.0.0:3000/api/unlock", {
    origin: "http://192.168.0.183",
    "x-forwarded-host": "192.168.0.183",
    "x-forwarded-proto": "http",
  });
  assert.equal(assertSameOrigin(req), true);
});

test("反代 https：X-Forwarded-Proto=https，Origin 为 https → true", () => {
  const req = make("http://0.0.0.0:3000/api/unlock", {
    origin: "https://tree.example.com",
    "x-forwarded-host": "tree.example.com",
    "x-forwarded-proto": "https",
  });
  assert.equal(assertSameOrigin(req), true);
});

test("转发为 https 但 Origin 仍是 http → false", () => {
  const req = make("http://0.0.0.0:3000/api/unlock", {
    origin: "http://tree.example.com",
    "x-forwarded-host": "tree.example.com",
    "x-forwarded-proto": "https",
  });
  assert.equal(assertSameOrigin(req), false);
});

test("多级代理逗号列表：取首个 X-Forwarded-Host/Proto", () => {
  const req = make("http://0.0.0.0:3000/api/unlock", {
    origin: "http://192.168.0.183",
    "x-forwarded-host": "192.168.0.183, internal:3000",
    "x-forwarded-proto": "http, http",
  });
  assert.equal(assertSameOrigin(req), true);
});

test("无转发头、无 Host（单测）：回退 request.url，Origin 匹配 → true", () => {
  const req = make("http://localhost/api/unlock", {
    origin: "http://localhost",
  });
  assert.equal(assertSameOrigin(req), true);
});

test("无转发头：request.url 是内部地址、Origin 是外部 → false（不得放行）", () => {
  const req = make("http://0.0.0.0:3000/api/unlock", {
    origin: "http://192.168.0.183",
  });
  assert.equal(assertSameOrigin(req), false);
});

test("Sec-Fetch-Site=cross-site → false（即使 Host 匹配）", () => {
  const req = make("http://0.0.0.0:3000/api/unlock", {
    origin: "http://evil.example",
    "sec-fetch-site": "cross-site",
    "x-forwarded-host": "evil.example",
  });
  assert.equal(assertSameOrigin(req), false);
});

test("无 Origin 头（如简单服务端调用）→ true", () => {
  const req = make("http://0.0.0.0:3000/api/unlock", {});
  // make 默认带 sec-fetch-site；单独删 origin（本就未设）
  assert.equal(assertSameOrigin(req), true);
});

test("畸形 Origin → false", () => {
  const req = make("http://0.0.0.0:3000/api/unlock", {
    origin: "not-a-url",
    "x-forwarded-host": "192.168.0.183",
  });
  assert.equal(assertSameOrigin(req), false);
});
