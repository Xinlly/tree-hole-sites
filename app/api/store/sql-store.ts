import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Store, StoredEntry, StoredMessage } from "./types.ts";

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

  async listMessages() {
    await this.ensureInitialized();
    const rows = this.getDb()
      .prepare(
        `SELECT id, nickname, content, created_at
       FROM visitor_messages
       ORDER BY id DESC
       LIMIT 100`,
      )
      .all() as MessageRow[];
    return rows.map(toMessage);
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

  async deleteMessage(id: number) {
    await this.ensureInitialized();
    this.getDb()
      .prepare("DELETE FROM visitor_messages WHERE id = ?")
      .run(id);
  }

  async listEntries() {
    await this.ensureInitialized();
    const rows = this.getDb()
      .prepare(
        `SELECT id, mood, content, reply, created_at
       FROM tree_hole_entries
       ORDER BY id DESC
       LIMIT 100`,
      )
      .all() as EntryRow[];
    return rows.map(toEntry);
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

  async deleteEntry(id: number) {
    await this.ensureInitialized();
    this.getDb()
      .prepare("DELETE FROM tree_hole_entries WHERE id = ?")
      .run(id);
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
    id: row.id,
    mood: row.mood,
    content: row.content,
    reply: row.reply,
    createdAt: row.created_at,
  };
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    nickname: row.nickname,
    content: row.content,
    createdAt: row.created_at,
  };
}
