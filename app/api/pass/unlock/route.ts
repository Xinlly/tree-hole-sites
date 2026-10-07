import {
  assertSameOrigin,
  setPassSessionCookie,
} from "../../tree-hole-auth";

// §3.3：恒 200，不存在"口令错误"概念（防口令枚举 oracle）。
// typo 口令进入空房间；不写内容则不建索引。
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) {
    return Response.json({ ok: false }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const passphrase =
    typeof body?.passphrase === "string" ? body.passphrase : "";

  // 任意（含空）输入都置 pass 会话；空口令同样进入其对应空房间
  await setPassSessionCookie(passphrase);
  return Response.json({ ok: true });
}
