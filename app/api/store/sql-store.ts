import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { encodeCursor } from "./cursor.ts";
import type {
  ListOptions,
  Page,
  Store,
  StoredEntry,
  StoredMessage,
} from "./types.ts";

type EntryRow = {
  id: number;
  mood: string;
  content: string;
  reply: string;
  created_at: string;
};

type MessageRow = {
  id: number;
  nickname: string;
  content: string;
  created_at: string;
};

export class SqlStore implements Store {
  private db: Database.Database | undefined;

  async ensureInitialized() {
    this.getDb().exec(
      `CREATE TABLE IF NOT EXISTS visitor_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
     CREATE INDEX IF NOT EXISTS visitor_messages_created_at_idx
       ON visitor_messages (created_at);
     CREATE TABLE IF NOT EXISTS tree_hole_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mood TEXT NOT NULL,
        content TEXT NOT NULL,
        reply TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
     CREATE INDEX IF NOT EXISTS tree_hole_entries_created_at_idx
       ON tree_hole_entries (created_at);`,
    );
  }

  async listMessages(options: ListOptions): Promise<Page<StoredMessage>> {
    await this.ensureInitialized();
    const rows = this.select<MessageRow>(
      "visitor_messages",
      "id, nickname, content, created_at",
      options,
    );
    return this.toPage(rows, options.limit, toMessage);
  }

  async createMessage(nickname: string, content: string) {
    await this.ensureInitialized();
    this.getDb()
      .prepare(
        `INSERT INTO visitor_messages (nickname, content)
       VALUES (?, ?)`,
      )
      .run(nickname, content);
  }

  async deleteMessage(id: string) {
    await this.ensureInitialized();
    this.getDb()
      .prepare("DELETE FROM visitor_messages WHERE id = ?")
      .run(Number(id));
  }

  async listEntries(options: ListOptions): Promise<Page<StoredEntry>> {
    await this.ensureInitialized();
    const rows = this.select<EntryRow>(
      "tree_hole_entries",
      "id, mood, content, reply, created_at",
      options,
    );
    return this.toPage(rows, options.limit, toEntry);
  }

  async createEntry(mood: string, content: string, reply: string) {
    await this.ensureInitialized();
    this.getDb()
      .prepare(
        `INSERT INTO tree_hole_entries (mood, content, reply)
       VALUES (?, ?, ?)`,
      )
      .run(mood, content, reply);
  }

  async deleteEntry(id: string) {
    await this.ensureInitialized();
    this.getDb()
      .prepare("DELETE FROM tree_hole_entries WHERE id = ?")
      .run(Number(id));
  }

  private select<R extends { id: number }>(
    table: string,
    columns: string,
    options: ListOptions,
  ): R[] {
    const limit = options.limit + 1;
    if (options.afterId) {
      return this.getDb()
        .prepare(
          `SELECT ${columns} FROM ${table}
       WHERE id < ?
       ORDER BY id DESC
       LIMIT ?`,
        )
        .all(Number(options.afterId), limit) as R[];
    }
    return this.getDb()
      .prepare(
        `SELECT ${columns} FROM ${table}
       ORDER BY id DESC
       LIMIT ?`,
      )
      .all(limit) as R[];
  }

  private toPage<R extends { id: number }, T extends { id: string }>(
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
  return {
    id: String(row.id),
    mood: row.mood,
    content: row.content,
    reply: row.reply,
    createdAt: row.created_at,
  };
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: String(row.id),
    nickname: row.nickname,
    content: row.content,
    createdAt: row.created_at,
  };
}
