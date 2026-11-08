import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The four FTS5 tables, named so a query can join and rank against them. They are out of the two
// drizzle-kit schemas because a virtual table is `CREATE VIRTUAL TABLE ... USING fts5`, which
// drizzle's schema cannot say: `migrations/` creates them and their triggers, and drizzle-kit never
// sees them. Only the columns a join reads are declared. The indexed text is the triggers' to
// write, and the column order bm25 weights by is the real table's, not anything said here.

export const memoriesFts = sqliteTable("memories_fts", { rowid: integer("rowid").notNull() });

export const artifactsFts = sqliteTable("artifacts_fts", { rowid: integer("rowid").notNull() });

export const sessionChunksFts = sqliteTable("session_chunks_fts", { rowid: integer("rowid").notNull() });

// The one that stores its own copy of the text: `session_history` is keyed by (user_id, session_id)
// and carries no INTEGER PRIMARY KEY for `content_rowid` to name, so the join runs on those two.
export const sessionHistoryFts = sqliteTable("session_history_fts", {
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull(),
});
