import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { monotonicFactory } from "ulid";
import { encodeCursor } from "./cursor.ts";
import {
  ConflictError,
  LockedError,
  NotFoundError,
} from "./types.ts";
import type {
  AccountPatch,
  EntryPatch,
  ListOptions,
  MessagePatch,
  MutateOptions,
  Page,
  PassSpaceInfo,
  Scope,
  StoredAccount,
  StoredEntry,
  StoredMessage,
  Store,
} from "./types.ts";

type EntryRow = {
  id: string;
  scope_kind: string;
  scope_id: string;
  mood: string;
  content: string;
  reply: string;
  locked: number;
  created_at: string;
  updated_at: string | null;
};

type MessageRow = {
  id: string;
  scope_kind: string;
  scope_id: string;
  nickname: string;
  content: string;
  locked: number;
  created_at: string;
  updated_at: string | null;
};

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  active: number;
  token_version: number;
  created_at: string;
};

export class SqlStore implements Store {
  private db: Database.Database | undefined;
  private newId = monotonicFactory();

  async ensureInitialized() {
    this.getDb().exec(
      `CREATE TABLE IF NOT EXISTS visitor_messages (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        content TEXT NOT NULL,
        locked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
     CREATE INDEX IF NOT EXISTS visitor_messages_scope_idx
       ON visitor_messages (scope_kind, scope_id, id);
     CREATE TABLE IF NOT EXISTS tree_hole_entries (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        mood TEXT NOT NULL,
        content TEXT NOT NULL,
        reply TEXT NOT NULL DEFAULT '',
        locked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
     CREATE INDEX IF NOT EXISTS tree_hole_entries_scope_idx
       ON tree_hole_entries (scope_kind, scope_id, id);
     CREATE TABLE IF NOT EXISTS tree_hole_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        token_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
     CREATE TABLE IF NOT EXISTS pass_space_index (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT ''
      );`,
    );
    // 兼容已有库：列不存在则补（建表 IF NOT EXISTS 不会给旧表加列）
    const cols = this.getDb().prepare("PRAGMA table_info(pass_space_index)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "label")) {
      this.getDb().exec("ALTER TABLE pass_space_index ADD COLUMN label TEXT NOT NULL DEFAULT ''");
    }
  }

  // —— 留言 ——

  async listMessages(scope: Scope, options: ListOptions): Promise<Page<StoredMessage>> {
    await this.ensureInitialized();
    const rows = this.selectScoped<MessageRow>(
      scope,
      "visitor_messages",
      "id, scope_kind, scope_id, nickname, content, locked, created_at, updated_at",
      options,
    );
    return this.toPage(rows, options.limit, toMessage);
  }

  async createMessage(scope: Scope, nickname: string, content: string) {
    await this.ensureInitialized();
    this.getDb()
      .prepare(
        `INSERT INTO visitor_messages
          (id, scope_kind, scope_id, nickname, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.newId(),
        scope.kind,
        scope.id,
        nickname,
        content,
        currentTimestamp(),
      );
  }

  async updateMessage(scope: Scope, id: string, patch: MessagePatch, options?: MutateOptions) {
    await this.ensureInitialized();
    await this.patchScoped(
      scope,
      "visitor_messages",
      id,
      {
        nickname: patch.nickname,
        content: patch.content,
      },
      options?.bypassLock ?? false,
    );
  }

  async setMessageLocked(scope: Scope, id: string, locked: boolean, options?: MutateOptions) {
    await this.ensureInitialized();
    await this.requireMutable(scope, "visitor_messages", id, options?.bypassLock ?? false);
    const result = this.getDb()
      .prepare(
        `UPDATE visitor_messages SET locked = ?, updated_at = ?
         WHERE scope_kind = ? AND scope_id = ? AND id = ?`,
      )
      .run(
        locked ? 1 : 0,
        currentTimestamp(),
        scope.kind,
        scope.id,
        id,
      );
    if (result.changes === 0) {
      throw new NotFoundError("message not found");
    }
  }

  async deleteMessage(scope: Scope, id: string) {
    await this.ensureInitialized();
    const result = this.getDb()
      .prepare(
        "DELETE FROM visitor_messages WHERE scope_kind = ? AND scope_id = ? AND id = ?",
      )
      .run(scope.kind, scope.id, id);
    if (result.changes === 0) {
      throw new NotFoundError("message not found");
    }
  }

  // —— 封存 ——

  async listEntries(scope: Scope, options: ListOptions): Promise<Page<StoredEntry>> {
    await this.ensureInitialized();
    const rows = this.selectScoped<EntryRow>(
      scope,
      "tree_hole_entries",
      "id, scope_kind, scope_id, mood, content, reply, locked, created_at, updated_at",
      options,
    );
    return this.toPage(rows, options.limit, toEntry);
  }

  async createEntry(scope: Scope, mood: string, content: string) {
    await this.ensureInitialized();
    this.getDb()
      .prepare(
        `INSERT INTO tree_hole_entries
          (id, scope_kind, scope_id, mood, content, reply, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.newId(),
        scope.kind,
        scope.id,
        mood,
        content,
        "",
        currentTimestamp(),
      );
  }

  async updateEntry(scope: Scope, id: string, patch: EntryPatch, options?: MutateOptions) {
    await this.ensureInitialized();
    await this.patchScoped(scope, "tree_hole_entries", id, {
      mood: patch.mood,
      content: patch.content,
    }, options?.bypassLock ?? false);
  }

  async setEntryReply(scope: Scope, id: string, reply: string) {
    await this.ensureInitialized();
    const result = this.getDb()
      .prepare(
        `UPDATE tree_hole_entries SET reply = ?
         WHERE scope_kind = ? AND scope_id = ? AND id = ?`,
      )
      .run(reply, scope.kind, scope.id, id);
    if (result.changes === 0) {
      throw new NotFoundError("entry not found");
    }
  }

  async setEntryLocked(scope: Scope, id: string, locked: boolean, options?: MutateOptions) {
    await this.ensureInitialized();
    await this.requireMutable(scope, "tree_hole_entries", id, options?.bypassLock ?? false);
    const result = this.getDb()
      .prepare(
        `UPDATE tree_hole_entries SET locked = ?, updated_at = ?
         WHERE scope_kind = ? AND scope_id = ? AND id = ?`,
      )
      .run(
        locked ? 1 : 0,
        currentTimestamp(),
        scope.kind,
        scope.id,
        id,
      );
    if (result.changes === 0) {
      throw new NotFoundError("entry not found");
    }
  }

  async deleteEntry(scope: Scope, id: string) {
    await this.ensureInitialized();
    const result = this.getDb()
      .prepare(
        "DELETE FROM tree_hole_entries WHERE scope_kind = ? AND scope_id = ? AND id = ?",
      )
      .run(scope.kind, scope.id, id);
    if (result.changes === 0) {
      throw new NotFoundError("entry not found");
    }
  }

  // —— 账号 ——

  async listUsers(): Promise<StoredAccount[]> {
    await this.ensureInitialized();
    const rows = this.getDb()
      .prepare(
        `SELECT id, username, password_hash, active, token_version, created_at
         FROM tree_hole_users`,
      )
      .all() as UserRow[];
    return rows.map(toUser);
  }

  async createUser(username: string, passwordHash: string): Promise<StoredAccount> {
    await this.ensureInitialized();
    const account: StoredAccount = {
      id: this.newId(),
      username,
      passwordHash,
      active: true,
      tokenVersion: 1,
      createdAt: currentTimestamp(),
    };
    try {
      this.getDb()
        .prepare(
          `INSERT INTO tree_hole_users
            (id, username, password_hash, active, token_version, created_at)
         VALUES (?, ?, ?, 1, 1, ?)`,
        )
        .run(
          account.id,
          account.username,
          account.passwordHash,
          account.createdAt,
        );
    } catch (error) {
      if (isUniqueError(error)) {
        throw new ConflictError("username already exists");
      }
      throw error;
    }
    return account;
  }

  async updateUser(id: string, patch: AccountPatch): Promise<StoredAccount> {
    await this.ensureInitialized();
    const db = this.getDb();
    const select = db.prepare(
      `SELECT id, username, password_hash, active, token_version, created_at
       FROM tree_hole_users WHERE id = ?`,
    );
    const existing = select.get(id) as UserRow | undefined;
    if (!existing) {
      throw new NotFoundError("user not found");
    }

    let tokenVersion = existing.token_version;
    let active = existing.active;
    let passwordHash = existing.password_hash;
    if (patch.passwordHash !== undefined) {
      passwordHash = patch.passwordHash;
      tokenVersion += 1;
    }
    if (patch.active !== undefined) {
      active = patch.active ? 1 : 0;
    }
    db.prepare(
      `UPDATE tree_hole_users
       SET password_hash = ?, active = ?, token_version = ?
       WHERE id = ?`,
    ).run(passwordHash, active, tokenVersion, id);

    return toUser(select.get(id) as UserRow);
  }

  // —— 口令空间索引 ——

  async listPassSpaces(): Promise<PassSpaceInfo[]> {
    await this.ensureInitialized();
    const rows = this.getDb()
      .prepare("SELECT id, created_at, label FROM pass_space_index ORDER BY created_at DESC")
      .all() as Array<{ id: string; created_at: string; label: string }>;
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at, label: row.label || undefined }));
  }

  async ensurePassSpace(id: string, label?: string): Promise<PassSpaceInfo> {
    await this.ensureInitialized();
    this.getDb()
      .prepare(
        "INSERT OR IGNORE INTO pass_space_index (id, created_at, label) VALUES (?, ?, ?)",
      )
      .run(id, currentTimestamp(), label ?? "");
    const row = this.getDb()
      .prepare("SELECT id, created_at, label FROM pass_space_index WHERE id = ?")
      .get(id) as { id: string; created_at: string; label: string };
    return { id: row.id, createdAt: row.created_at, label: row.label || undefined };
  }

  // —— 内部 ——

  private selectScoped<R>(
    scope: Scope,
    table: string,
    columns: string,
    options: ListOptions,
  ): R[] {
    const limit = options.limit + 1;
    if (options.afterId) {
      return this.getDb()
        .prepare(
          `SELECT ${columns} FROM ${table}
       WHERE scope_kind = ? AND scope_id = ? AND id < ?
       ORDER BY id DESC
       LIMIT ?`,
        )
        .all(scope.kind, scope.id, options.afterId, limit) as R[];
    }
    return this.getDb()
      .prepare(
        `SELECT ${columns} FROM ${table}
       WHERE scope_kind = ? AND scope_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      )
      .all(scope.kind, scope.id, limit) as R[];
  }

  // 成员路径命中 locked 抛 LockedError；管理员 bypassLock
  private requireMutable(
    scope: Scope,
    table: string,
    id: string,
    bypassLock: boolean,
  ) {
    if (bypassLock) return;
    const row = this.getDb()
      .prepare(`SELECT locked FROM ${table} WHERE scope_kind = ? AND scope_id = ? AND id = ?`)
      .get(scope.kind, scope.id, id) as { locked: number } | undefined;
    if (!row) {
      throw new NotFoundError("item not found");
    }
    if (row.locked === 1) {
      throw new LockedError("item is locked");
    }
  }

  private patchScoped(
    scope: Scope,
    table: string,
    id: string,
    fields: Record<string, string | undefined>,
    bypassLock: boolean,
  ) {
    const sets: string[] = [];
    const values: string[] = [];
    for (const [column, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (sets.length === 0) {
      return;
    }
    this.requireMutable(scope, table, id, bypassLock);
    sets.push("updated_at = ?");
    const result = this.getDb()
      .prepare(
        `UPDATE ${table} SET ${sets.join(", ")}
         WHERE scope_kind = ? AND scope_id = ? AND id = ?`,
      )
      .run(
        ...values,
        currentTimestamp(),
        scope.kind,
        scope.id,
        id,
      );
    if (result.changes === 0) {
      throw new NotFoundError(`${table.replace(/_/g, " ").replace(/s$/, "")} not found`);
    }
  }

  private toPage<R extends { id: string }, T extends { id: string }>(
    rows: R[],
    limit: number,
    mapper: (row: R) => T,
  ): Page<T> {
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(mapper);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ afterId: String(last.id) }) : null;
    return { items, nextCursor, hasMore };
  }

  private getDb() {
    if (!this.db) {
      const dbPath = process.env.TREE_HOLE_DB_PATH ?? "./data/tree-hole.db";
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
    }
    return this.db;
  }
}

function toEntry(row: EntryRow): StoredEntry {
  const entry: StoredEntry = {
    id: row.id,
    scopeKind: row.scope_kind as StoredEntry["scopeKind"],
    scopeId: row.scope_id,
    mood: row.mood,
    content: row.content,
    reply: row.reply,
    locked: row.locked === 1,
    createdAt: row.created_at,
  };
  if (row.updated_at) {
    entry.updatedAt = row.updated_at;
  }
  return entry;
}

function toMessage(row: MessageRow): StoredMessage {
  const message: StoredMessage = {
    id: row.id,
    scopeKind: row.scope_kind as StoredMessage["scopeKind"],
    scopeId: row.scope_id,
    nickname: row.nickname,
    content: row.content,
    locked: row.locked === 1,
    createdAt: row.created_at,
  };
  if (row.updated_at) {
    message.updatedAt = row.updated_at;
  }
  return message;
}

function toUser(row: UserRow): StoredAccount {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    active: row.active === 1,
    tokenVersion: row.token_version,
    createdAt: row.created_at,
  };
}

function currentTimestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(
    now.getUTCDate(),
  )} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(
    now.getUTCSeconds(),
  )}`;
}

function isUniqueError(error: unknown): boolean {
  const target = error as { code?: string } | null;
  return target?.code === "SQLITE_CONSTRAINT_UNIQUE";
}
