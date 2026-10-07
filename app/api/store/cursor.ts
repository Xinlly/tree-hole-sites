// 不透明游标：仅编码上一页最后返回项的 ULID（afterId），
// 可附带不可变封存块提示 {blockKey,index}（§4.2/§5）。
// v3：块键携带空间前缀；调用方须确认块键空间与当前会话空间一致（§5）。
import { Buffer } from "node:buffer";

const ULID = "[0-9A-HJKMNP-TV-Z]{26}"; // Crockford，大写
const COLLECTION = "(?:messages|entries)";
const BLOCK_SUFFIX = `/blocks/${ULID}\\.json\\.gz`;

// §5 三类 v3 块键前缀
export const V3_PUBLIC_BLOCK_RE = new RegExp(
  `^v3/public/${COLLECTION}${BLOCK_SUFFIX}$`,
);
export const V3_PASS_BLOCK_RE = new RegExp(
  `^v3/pass/[0-9a-f]{64}/${COLLECTION}${BLOCK_SUFFIX}$`,
);
export const V3_USER_BLOCK_RE = new RegExp(
  `^v3/user/${ULID}/${COLLECTION}${BLOCK_SUFFIX}$`,
);
const V3_ANY_BLOCK_RE = new RegExp(
  `^v3/(?:public|pass/[0-9a-f]{64}|user/${ULID})/${COLLECTION}${BLOCK_SUFFIX}$`,
);

const ID_RE = new RegExp(`^${ULID}$`);

export type CursorValue = {
  afterId: string;
  blockKey?: string | undefined;
  index?: number | undefined;
};

export function encodeCursor(value: CursorValue): string {
  const payload: CursorValue = { afterId: value.afterId };
  if (value.blockKey !== undefined) {
    payload.blockKey = value.blockKey;
  }
  if (value.index !== undefined) {
    payload.index = value.index;
  }
  return Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64url");
}

export function decodeCursor(cursor: string): CursorValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid cursor");
  }
  const value = parsed as {
    afterId?: unknown;
    blockKey?: unknown;
    index?: unknown;
  };
  if (
    typeof value.afterId !== "string" ||
    !ID_RE.test(value.afterId)
  ) {
    throw new Error("invalid cursor");
  }
  const hasBlock = value.blockKey !== undefined;
  const hasIndex = value.index !== undefined;
  if (hasBlock !== hasIndex) {
    throw new Error("invalid cursor");
  }
  if (hasBlock) {
    if (
      typeof value.blockKey !== "string" ||
      !V3_ANY_BLOCK_RE.test(value.blockKey)
    ) {
      throw new Error("invalid cursor");
    }
    if (
      typeof value.index !== "number" ||
      !Number.isInteger(value.index) ||
      value.index < 0 ||
      value.index > 19
    ) {
      throw new Error("invalid cursor");
    }
  }
  return {
    afterId: value.afterId,
    blockKey: hasBlock ? (value.blockKey as string) : undefined,
    index: hasBlock ? (value.index as number) : undefined,
  };
}

// 块键前缀必须与当前会话空间一致（跨空间游标不可用，§5/§8）
export function blockKeyMatchesScope(blockKey: string, scope: ScopeLike): boolean {
  if (scope.kind === "public") {
    return V3_PUBLIC_BLOCK_RE.test(blockKey);
  }
  if (scope.kind === "pass") {
    return V3_PASS_BLOCK_RE.test(blockKey) &&
      blockKey.startsWith(`v3/pass/${scope.id}/`);
  }
  return V3_USER_BLOCK_RE.test(blockKey) &&
    blockKey.startsWith(`v3/user/${scope.id}/`);
}

type ScopeLike = { kind: string; id: string };
