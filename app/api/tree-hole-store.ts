import { getStore } from "./store/index.ts";
import { decodeCursor } from "./store/cursor.ts";
import {
  ConflictError,
  LockedError,
  NotFoundError,
} from "./store/types.ts";
import type {
  EntryPatch,
  ListOptions,
  MessagePatch,
  MutateOptions,
  Scope,
  StoredEntry,
  StoredMessage,
} from "./store/types.ts";

export type { StoredEntry, StoredMessage };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const ADMIN_LIMIT = 100;

export { NotFoundError };

export async function ensureTables() {
  await getStore().ensureInitialized();
}

// —— 留言 ——

export function listMessages(scope: Scope, options?: Partial<ListOptions>) {
  return getStore().listMessages(scope, withLimit(options));
}

export function createMessage(scope: Scope, nickname: string, content: string) {
  return getStore().createMessage(scope, nickname, content);
}

export function updateMessage(
  scope: Scope,
  id: string,
  patch: MessagePatch,
  options?: MutateOptions,
) {
  return getStore().updateMessage(scope, id, patch, options);
}

export function setMessageLocked(
  scope: Scope,
  id: string,
  locked: boolean,
  options?: MutateOptions,
) {
  return getStore().setMessageLocked(scope, id, locked, options);
}

export function deleteMessage(scope: Scope, id: string) {
  return getStore().deleteMessage(scope, id);
}

// —— 封存 ——

export function listEntries(scope: Scope, options?: Partial<ListOptions>) {
  return getStore().listEntries(scope, withLimit(options));
}

export function createEntry(scope: Scope, mood: string, content: string) {
  return getStore().createEntry(scope, mood, content);
}

export function updateEntry(
  scope: Scope,
  id: string,
  patch: EntryPatch,
  options?: MutateOptions,
) {
  return getStore().updateEntry(scope, id, patch, options);
}

export function setEntryReply(scope: Scope, id: string, reply: string) {
  return getStore().setEntryReply(scope, id, reply);
}

export function setEntryLocked(
  scope: Scope,
  id: string,
  locked: boolean,
  options?: MutateOptions,
) {
  return getStore().setEntryLocked(scope, id, locked, options);
}

export function deleteEntry(scope: Scope, id: string) {
  return getStore().deleteEntry(scope, id);
}

// —— 管理员跨空间聚合（§4.3 服务层）——

// 公共空间 + 每个口令空间 + 每个账号空间分别收全量
export async function listAllAcrossScopes(): Promise<{
  messages: StoredMessage[];
  entries: StoredEntry[];
}> {
  const store = getStore();
  const [passSpaces, users] = await Promise.all([
    store.listPassSpaces(),
    store.listUsers(),
  ]);
  const scopes: Scope[] = [
    { kind: "public", id: "" },
    ...passSpaces.map((info): Scope => ({ kind: "pass", id: info.id })),
    ...users.map((user): Scope => ({ kind: "user", id: user.id })),
  ];
  const messages: StoredMessage[] = [];
  const entries: StoredEntry[] = [];
  for (const scope of scopes) {
    messages.push(...await collectAll((options) => listMessages(scope, options)));
    entries.push(...await collectAll((options) => listEntries(scope, options)));
  }
  return { messages, entries };
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

// Store 错误 → HTTP 状态（NotFound=404 / Locked·Conflict=409，其余 500）
export function errorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof NotFoundError) {
    return { status: 404, message: error.message };
  }
  if (error instanceof LockedError || error instanceof ConflictError) {
    return { status: 409, message: error.message };
  }
  return { status: 500, message: toErrorMessage(error) };
}
