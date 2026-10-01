// §4.1：四类空间中除 admin 外的三类数据归属。scopeId 只从会话 cookie 派生。
export type ScopeKind = "public" | "pass" | "user";

export type Scope = {
  kind: ScopeKind;
  // public 固定 ""；pass=口令空间 id（sha256 hex, 64 字符）；user=账号 ULID
  id: string;
};

export type StoredMessage = {
  id: string; // ULID
  scopeKind: ScopeKind;
  scopeId: string;
  nickname: string;
  content: string;
  locked: boolean;
  createdAt: string;
  updatedAt?: string; // 最近修改；未改不存在
};

export type StoredEntry = {
  id: string; // ULID
  scopeKind: ScopeKind;
  scopeId: string;
  mood: string;
  content: string;
  reply: string;
  locked: boolean;
  createdAt: string;
  updatedAt?: string;
};

// §4.4：账号
export type StoredAccount = {
  id: string; // ULID
  username: string; // 唯一，大小写不敏感
  passwordHash: string; // sha256("tree-hole-user:v1:" + password)
  active: boolean;
  tokenVersion: number; // 初始 1；改密/重置 +1
  createdAt: string;
};

// §4.5：口令空间索引项
export type PassSpaceInfo = {
  id: string;
  createdAt: string;
};

export type ListOptions = {
  afterId?: string | undefined;
  blockKey?: string | undefined;
  index?: number | undefined;
  limit: number;
};

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type MessagePatch = {
  nickname?: string;
  content?: string;
};

export type EntryPatch = {
  mood?: string;
  content?: string;
};

// passwordHash 提供 => store 内同时 tokenVersion+1；active=false 停用、true 启用不 bump
export type AccountPatch = {
  passwordHash?: string;
  active?: boolean;
};

// 成员路径 store 检查 locked 并抛 LockedError；管理员经路由鉴权后传 bypassLock 绕过
export type MutateOptions = {
  bypassLock?: boolean;
};

// 路由据此转 404；两实现共用
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

// 账号重名（含大小写变体）；路由转 409
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

// 成员修改/再锁已锁定内容；路由转 409
export class LockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockedError";
  }
}

export interface Store {
  ensureInitialized(): Promise<void>;

  listMessages(scope: Scope, options: ListOptions): Promise<Page<StoredMessage>>;
  createMessage(scope: Scope, nickname: string, content: string): Promise<void>;
  updateMessage(
    scope: Scope,
    id: string,
    patch: MessagePatch,
    options?: MutateOptions,
  ): Promise<void>;
  setMessageLocked(
    scope: Scope,
    id: string,
    locked: boolean,
    options?: MutateOptions,
  ): Promise<void>;
  deleteMessage(scope: Scope, id: string): Promise<void>;

  listEntries(scope: Scope, options: ListOptions): Promise<Page<StoredEntry>>;
  createEntry(scope: Scope, mood: string, content: string): Promise<void>;
  updateEntry(
    scope: Scope,
    id: string,
    patch: EntryPatch,
    options?: MutateOptions,
  ): Promise<void>;
  setEntryReply(scope: Scope, id: string, reply: string): Promise<void>;
  setEntryLocked(
    scope: Scope,
    id: string,
    locked: boolean,
    options?: MutateOptions,
  ): Promise<void>;
  deleteEntry(scope: Scope, id: string): Promise<void>;

  // §4.4 账号
  listUsers(): Promise<StoredAccount[]>;
  createUser(username: string, passwordHash: string): Promise<StoredAccount>;
  updateUser(id: string, patch: AccountPatch): Promise<StoredAccount>;

  // §4.5 口令空间
  listPassSpaces(): Promise<PassSpaceInfo[]>;
  ensurePassSpace(id: string): Promise<PassSpaceInfo>;
}
