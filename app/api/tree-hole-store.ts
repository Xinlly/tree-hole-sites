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

declare global {
  var TREE_HOLE_DB: D1Database | undefined;
}

export async function ensureTables() {
  const db = getDb();
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS visitor_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS visitor_messages_created_at_idx
       ON visitor_messages (created_at)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS tree_hole_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mood TEXT NOT NULL,
        content TEXT NOT NULL,
        reply TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS tree_hole_entries_created_at_idx
       ON tree_hole_entries (created_at)`,
    ),
  ]);
}

export async function listMessages() {
  await ensureTables();
  const { results } = await getDb()
    .prepare(
      `SELECT id, nickname, content, created_at
       FROM visitor_messages
       ORDER BY id DESC
       LIMIT 100`,
    )
    .all<MessageRow>();
  return results.map(toMessage);
}

export async function createMessage(nickname: string, content: string) {
  await ensureTables();
  await getDb()
    .prepare(
      `INSERT INTO visitor_messages (nickname, content)
       VALUES (?, ?)`,
    )
    .bind(nickname, content)
    .run();
}

export async function deleteMessage(id: number) {
  await ensureTables();
  await getDb()
    .prepare("DELETE FROM visitor_messages WHERE id = ?")
    .bind(id)
    .run();
}

export async function listEntries() {
  await ensureTables();
  const { results } = await getDb()
    .prepare(
      `SELECT id, mood, content, reply, created_at
       FROM tree_hole_entries
       ORDER BY id DESC
       LIMIT 100`,
    )
    .all<EntryRow>();
  return results.map(toEntry);
}

export async function createEntry(mood: string, content: string, reply: string) {
  await ensureTables();
  await getDb()
    .prepare(
      `INSERT INTO tree_hole_entries (mood, content, reply)
       VALUES (?, ?, ?)`,
    )
    .bind(mood, content, reply)
    .run();
}

export async function deleteEntry(id: number) {
  await ensureTables();
  await getDb()
    .prepare("DELETE FROM tree_hole_entries WHERE id = ?")
    .bind(id)
    .run();
}

export function normalizeNickname(value: string | undefined) {
  const nickname = value?.trim();
  return nickname ? nickname.slice(0, 24) : "匿名";
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function getDb() {
  const db = globalThis.TREE_HOLE_DB;
  if (!db) throw new Error("D1 binding `DB` is unavailable.");
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
