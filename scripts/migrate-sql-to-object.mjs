#!/usr/bin/env node
// 停机态一次性迁移：SQLite 全量 -> OSS 两个集合对象。可重复执行（覆盖写、幂等）。
import Database from "better-sqlite3";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const REQUIRED = [
  "STORAGE_OBJECT_ENDPOINT",
  "STORAGE_OBJECT_REGION",
  "STORAGE_OBJECT_BUCKET",
  "STORAGE_OBJECT_ACCESS_KEY_ID",
  "STORAGE_OBJECT_SECRET_ACCESS_KEY",
];

const MAX_ITEMS = 100;

function buildCollection(rows, toItem) {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const nextId = sorted.length > 0 ? sorted[sorted.length - 1].id + 1 : 1;
  const items = sorted.slice(-MAX_ITEMS).map(toItem);
  return { nextId, items };
}

async function main() {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing object storage config: ${missing.join(", ")}`);
  }

  const dbPath = process.env.TREE_HOLE_DB_PATH ?? "./data/tree-hole.db";
  const db = new Database(dbPath, { readonly: true });

  let messages;
  let entries;
  try {
    messages = db
      .prepare(
        `SELECT id, nickname, content, created_at FROM visitor_messages`,
      )
      .all();
    entries = db
      .prepare(
        `SELECT id, mood, content, reply, created_at FROM tree_hole_entries`,
      )
      .all();
  } finally {
    db.close();
  }

  const messageCollection = buildCollection(messages, (row) => ({
    id: row.id,
    nickname: row.nickname,
    content: row.content,
    createdAt: row.created_at,
  }));
  const entryCollection = buildCollection(entries, (row) => ({
    id: row.id,
    mood: row.mood,
    content: row.content,
    reply: row.reply,
    createdAt: row.created_at,
  }));

  const client = new S3Client({
    region: process.env.STORAGE_OBJECT_REGION,
    endpoint: process.env.STORAGE_OBJECT_ENDPOINT,
    credentials: {
      accessKeyId: process.env.STORAGE_OBJECT_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_OBJECT_SECRET_ACCESS_KEY,
    },
    requestHandler: new NodeHttpHandler({
      requestTimeout: 5000,
      connectionTimeout: 3000,
    }),
  });

  const bucket = process.env.STORAGE_OBJECT_BUCKET;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "visitor-messages.json",
      Body: JSON.stringify(messageCollection),
      ContentType: "application/json",
    }),
  );
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "tree-hole-entries.json",
      Body: JSON.stringify(entryCollection),
      ContentType: "application/json",
    }),
  );

  console.log(
    `migrated ${messages.length} messages (kept ${messageCollection.items.length}), ` +
      `${entries.length} entries (kept ${entryCollection.items.length})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
