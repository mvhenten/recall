import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { vector } from "./columns";

// One account's own tables, in the Durable Object addressed by its user id. Every table here keeps
// its `user_id` column: one object holds one account, so the column is redundant and dropping it
// would rewrite every query for nothing.
//
// Tables and columns only, for the reason `./account` gives: the DESC indexes the keyset pages
// walk, the four FTS5 tables and their triggers are hand-written in `migrations/tenant/`.

export const sessions = sqliteTable(
  "sessions",
  {
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    deviceId: text("device_id").notNull(),
    deviceName: text("device_name").notNull().default(""),
    host: text("host").notNull(),
    cwd: text("cwd").notNull(),
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    commitSubject: text("commit_subject").notNull(),
    startedAt: integer("started_at").notNull(),
    lastActivityAt: integer("last_activity_at").notNull(),
    prompts: integer("prompts").notNull(),
    focusFirst: text("focus_first").notNull(),
    focusLatest: text("focus_latest").notNull(),
    mode: text("mode", { enum: ["interactive", "headless", ""] }).notNull(),
    permissionMode: text("permission_mode").notNull(),
    pid: integer("pid").notNull(),
    agentName: text("agent_name").notNull().default(""),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId] })],
);

export const sessionHistory = sqliteTable(
  "session_history",
  {
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    deviceId: text("device_id").notNull(),
    deviceName: text("device_name").notNull(),
    host: text("host").notNull(),
    cwd: text("cwd").notNull(),
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    commitSubject: text("commit_subject").notNull(),
    startedAt: integer("started_at").notNull(),
    lastActivityAt: integer("last_activity_at").notNull(),
    prompts: integer("prompts").notNull(),
    focusFirst: text("focus_first").notNull(),
    focusLatest: text("focus_latest").notNull(),
    mode: text("mode", { enum: ["interactive", "headless", ""] }).notNull(),
    agentName: text("agent_name").notNull().default(""),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId] })],
);

export const sessionIndex = sqliteTable(
  "session_index",
  {
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    archived: integer("archived").notNull(),
    bytes: integer("bytes").notNull(),
    chunks: integer("chunks").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId] })],
);

// `chunk_seq` is `session_chunks_fts`'s content_rowid, which is why it is an INTEGER PRIMARY KEY
// and why the delete trigger in `migrations/tenant/0001_tenant.sql` is load-bearing: SQLite hands
// a deleted rowid out again.
export const sessionChunks = sqliteTable(
  "session_chunks",
  {
    chunkSeq: integer("chunk_seq").primaryKey(),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    speaker: text("speaker", { enum: ["user", "model"] }).notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [unique().on(table.userId, table.sessionId, table.ordinal)],
);

// WITHOUT ROWID in `migrations/tenant/0001_tenant.sql`, which drizzle's schema cannot say.
export const sessionRecords = sqliteTable(
  "session_records",
  {
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    file: text("file").notNull(),
    nextOrdinal: integer("next_ordinal").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId, table.file] })],
);

// WITHOUT ROWID likewise.
export const sessionOpenChunks = sqliteTable(
  "session_open_chunks",
  {
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    file: text("file").notNull(),
    speaker: text("speaker", { enum: ["user", "model"] }).notNull(),
    pieces: text("pieces").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId, table.file, table.speaker] })],
);

export const usageEvents = sqliteTable(
  "usage_events",
  {
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    provider: text("provider").notNull(),
    account: text("account").notNull(),
    model: text("model").notNull(),
    prompts: integer("prompts").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    at: integer("at").notNull(),
    recordedAt: integer("recorded_at").notNull(),
    durable: integer("durable").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId, table.seq] })],
);

export const usageDaily = sqliteTable(
  "usage_daily",
  {
    userId: text("user_id").notNull(),
    day: text("day").notNull(),
    host: text("host").notNull(),
    repo: text("repo").notNull(),
    account: text("account").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    prompts: integer("prompts").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.day, table.host, table.repo, table.account, table.provider, table.model],
    }),
  ],
);

export const labels = sqliteTable(
  "labels",
  {
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["host", "account"] }).notNull(),
    value: text("value").notNull(),
    label: text("label").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.kind, table.value] })],
);

export const countedFiles = sqliteTable(
  "counted_files",
  {
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    file: text("file").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId, table.file] })],
);

export const boardMessages = sqliteTable(
  "board_messages",
  {
    userId: text("user_id").notNull(),
    messageId: text("message_id").notNull(),
    scope: text("scope", { enum: ["fleet", "host", "session"] }).notNull(),
    target: text("target").notNull(),
    fromDeviceId: text("from_device_id").notNull(),
    fromHost: text("from_host").notNull(),
    fromName: text("from_name").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.messageId] })],
);

// WITHOUT ROWID likewise. The primary key is the whole of the single-taker guarantee.
export const boardPickups = sqliteTable(
  "board_pickups",
  {
    userId: text("user_id").notNull(),
    messageId: text("message_id").notNull(),
    sessionId: text("session_id").notNull(),
    deviceId: text("device_id").notNull(),
    host: text("host").notNull(),
    pickedUpAt: integer("picked_up_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.messageId] })],
);
