import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export function getDb() {
  const dbPath = process.env.TREE_HOLE_DB_PATH ?? "./data/tree-hole.db";
  return drizzle(new Database(dbPath), { schema });
}
