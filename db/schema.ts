import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const visitorMessages = sqliteTable("visitor_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  nickname: text("nickname").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const treeHoleEntries = sqliteTable("tree_hole_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mood: text("mood").notNull(),
  content: text("content").notNull(),
  reply: text("reply").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
