import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type StoredEntry = {
  id: number;
  mood: string;
  content: string;
  reply: string;
  createdAt: string;
};

export type StoredMessage = {
  id: number;
  nickname: string;
  content: string;
  createdAt: string;
};

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

let db: Database.Database | undefined;

export async function ensureTables() {
  getDb().exec(
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

export async function listMessages() {
  await ensureTables();
  const rows = getDb()
    .prepare(
      `SELECT id, nickname, content, created_at
       FROM visitor_messages
       ORDER BY id DESC
       LIMIT 100`,
    )
    .all() as MessageRow[];
  return rows.map(toMessage);
}

export async function createMessage(nickname: string, content: string) {
  await ensureTables();
  getDb()
    .prepare(
      `INSERT INTO visitor_messages (nickname, content)
       VALUES (?, ?)`,
    )
    .run(nickname, content);
}

export async function deleteMessage(id: number) {
  await ensureTables();
  getDb()
    .prepare("DELETE FROM visitor_messages WHERE id = ?")
    .run(id);
}

export async function listEntries() {
  await ensureTables();
  const rows = getDb()
    .prepare(
      `SELECT id, mood, content, reply, created_at
       FROM tree_hole_entries
       ORDER BY id DESC
       LIMIT 100`,
    )
    .all() as EntryRow[];
  return rows.map(toEntry);
}

export async function createEntry(mood: string, content: string, reply: string) {
  await ensureTables();
  getDb()
    .prepare(
      `INSERT INTO tree_hole_entries (mood, content, reply)
       VALUES (?, ?, ?)`,
    )
    .run(mood, content, reply);
}

export async function deleteEntry(id: number) {
  await ensureTables();
  getDb()
    .prepare("DELETE FROM tree_hole_entries WHERE id = ?")
    .run(id);
}

export function normalizeNickname(value: string | undefined) {
  const nickname = value?.trim();
  return nickname ? nickname.slice(0, 24) : "匿名";
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function getDb() {
  if (!db) {
    const dbPath = process.env.TREE_HOLE_DB_PATH ?? "./data/tree-hole.db";
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
  }
  return db;
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
