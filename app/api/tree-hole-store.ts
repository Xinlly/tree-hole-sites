import { getStore } from "./store/index.ts";
import { decodeCursor } from "./store/cursor.ts";
import type {
  ListOptions,
  StoredEntry,
  StoredMessage,
} from "./store/types.ts";

export type { StoredEntry, StoredMessage };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const ADMIN_LIMIT = 100;

export async function ensureTables() {
  await getStore().ensureInitialized();
}

export async function listMessages(options?: Partial<ListOptions>) {
  return getStore().listMessages(withLimit(options));
}

export async function listEntries(options?: Partial<ListOptions>) {
  return getStore().listEntries(withLimit(options));
}

export async function createMessage(nickname: string, content: string) {
  await getStore().createMessage(nickname, content);
}

export async function deleteMessage(id: string) {
  await getStore().deleteMessage(id);
}

export async function createEntry(mood: string, content: string, reply: string) {
  await getStore().createEntry(mood, content, reply);
}

export async function deleteEntry(id: string) {
  await getStore().deleteEntry(id);
}

// 管理员需要全量：按游标翻页直到收完
export async function listAllEntries() {
  return collectAll(listEntries);
}

export async function listAllMessages() {
  return collectAll(listMessages);
}

async function collectAll<T>(
  list: (options: Partial<ListOptions>) => Promise<{
    items: T[];
    nextCursor: string | null;
    hasMore: boolean;
  }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const options: Partial<ListOptions> = { limit: ADMIN_LIMIT };
    if (cursor) {
      Object.assign(options, decodeCursor(cursor));
    }
    const page = await list(options);
    items.push(...page.items);
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor);
  return items;
}

function withLimit(options?: Partial<ListOptions>): ListOptions {
  return {
    afterId: options?.afterId,
    blockKey: options?.blockKey,
    index: options?.index,
    limit: options?.limit ?? DEFAULT_LIMIT,
  };
}

// 解析 GET 的 cursor/limit 查询参数；畸形返回 error（路由转 400）
export function parseListQuery(url: URL): {
  options?: Partial<ListOptions>;
  error?: string;
} {
  const options: Partial<ListOptions> = {};
  const limitParam = url.searchParams.get("limit");
  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam)) {
      return { error: "invalid limit" };
    }
    const limit = Number(limitParam);
    if (limit < 1 || limit > MAX_LIMIT) {
      return { error: "invalid limit" };
    }
    options.limit = limit;
  }
  const cursorParam = url.searchParams.get("cursor");
  if (cursorParam !== null) {
    try {
      const decoded = decodeCursor(cursorParam);
      options.afterId = decoded.afterId;
      options.blockKey = decoded.blockKey;
      options.index = decoded.index;
    } catch {
      return { error: "invalid cursor" };
    }
  }
  return { options };
}

export function normalizeNickname(value: string | undefined) {
  const nickname = value?.trim();
  return nickname ? nickname.slice(0, 24) : "匿名";
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}
