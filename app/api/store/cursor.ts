// 不透明游标：仅编码上一页最后返回项的 ULID（afterId），
// 可附带不可变封存块提示 {blockKey,index}（设计 §4.2）。
import { Buffer } from "node:buffer";

const ID_RE = /^(?:[0-9A-HJKMNP-TV-Z]{26}|\d+)$/;

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
      !/^v2\/(?:messages|entries)\/blocks\/.+\.json\.gz$/.test(value.blockKey)
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
    index: hasIndex ? (value.index as number) : undefined,
  };
}
