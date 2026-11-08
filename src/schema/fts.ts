import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The four FTS5 tables, named so a query can join and rank against them. They are deliberately out
// of the two drizzle-kit schemas: a virtual table is `CREATE VIRTUAL TABLE ... USING fts5`, which
// drizzle's schema cannot say, so `migrations/` creates them and their triggers and drizzle-kit
// never sees them. Nothing writes a row here — every one of them is filled by a trigger.
//
// `rowid` is the column the external-content tables are joined back to their content table by.

export const memoriesFts = sqliteTable("memories_fts", {
  rowid: integer("rowid").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  body: text("body").notNull(),
});

export const artifactsFts = sqliteTable("artifacts_fts", {
  rowid: integer("rowid").notNull(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
});

export const sessionChunksFts = sqliteTable("session_chunks_fts", {
  rowid: integer("rowid").notNull(),
  text: text("text").notNull(),
});

// The one that stores its own copy of the text: `session_history` is keyed by (user_id, session_id)
// and carries no INTEGER PRIMARY KEY for `content_rowid` to name.
export const sessionHistoryFts = sqliteTable("session_history_fts", {
  rowid: integer("rowid").notNull(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull(),
  focusFirst: text("focus_first").notNull(),
  focusLatest: text("focus_latest").notNull(),
  commitSubject: text("commit_subject").notNull(),
  agentName: text("agent_name").notNull(),
});
