import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { vector } from "./columns";

// D1's artifact, memory and session tables, as `migrations/` left them. They are out of
// `./account` because no request path reads them any more: `../artifact-copy`, `../memory-copy`
// and `../session-copy` are their one reader each, and each copies what they hold into the
// account's own object. `migrations/0022_artifact_names.sql` says why the rows stay where they
// are, and step E of #115 is what takes the tables away.
//
// None is in `drizzle.config.ts`, so drizzle-kit neither sees them nor writes a migration for
// them. The one artifact column that differs from the tenant's copy is `last_writer_user_id`,
// which the copy resolves to an address through `principals`; the memory tables are column for
// column what the tenant object now holds, and so are the session tables bar
// `session_index.indexed_at`, which `migrations/0010_archive_events.sql` left behind and nothing
// reads.

export const legacyArtifacts = sqliteTable(
  "artifacts",
  {
    artifactSeq: integer("artifact_seq").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    rev: integer("rev").notNull(),
    type: text("type", { enum: ["site", "document", "audio"] }).notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    readPerm: text("read_perm", { enum: ["private", "account"] }).notNull(),
    writePerm: text("write_perm", { enum: ["owner", "account"] }).notNull(),
    entryPath: text("entry_path").notNull(),
    files: text("files").notNull(),
    fileCount: integer("file_count").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastWriterUserId: text("last_writer_user_id").notNull(),
  },
  (table) => [unique().on(table.userId, table.name)],
);

export const legacyArtifactRevisions = sqliteTable(
  "artifact_revisions",
  {
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    revNext: integer("rev_next").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.name] })],
);

export const legacyMemories = sqliteTable(
  "memories",
  {
    memorySeq: integer("memory_seq").primaryKey(),
    memoryId: text("memory_id").notNull().unique(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    type: text("type", { enum: ["user", "feedback", "project", "reference"] }).notNull(),
    body: text("body").notNull(),
    embedding: vector("embedding").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    recallCount: integer("recall_count").notNull(),
    lastRecalledAt: integer("last_recalled_at").notNull(),
  },
  (table) => [unique().on(table.userId, table.name)],
);

export const legacyMemoryTags = sqliteTable(
  "memory_tags",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => legacyMemories.memoryId, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (table) => [primaryKey({ columns: [table.memoryId, table.tag] })],
);

// What `migrations/tenant/0001_tenant.sql` took over: the account's sessions, its prose index, its
// usage, its labels and its board. The field names are the tenant schema's, so a row read out of
// D1 is a row `../session-copy` hands straight to the matching insert.

export const legacySessions = sqliteTable(
  "sessions",
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
    permissionMode: text("permission_mode").notNull(),
    pid: integer("pid").notNull(),
    agentName: text("agent_name").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId] })],
);

export const legacySessionHistory = sqliteTable(
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
    agentName: text("agent_name").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId] })],
);

export const legacySessionIndex = sqliteTable(
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

export const legacySessionChunks = sqliteTable(
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

export const legacySessionRecords = sqliteTable(
  "session_records",
  {
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    file: text("file").notNull(),
    nextOrdinal: integer("next_ordinal").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId, table.file] })],
);

export const legacySessionOpenChunks = sqliteTable(
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

export const legacyUsageEvents = sqliteTable(
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
    durable: integer("durable").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId, table.seq] })],
);

export const legacyUsageDaily = sqliteTable(
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

export const legacyLabels = sqliteTable(
  "labels",
  {
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["host", "account"] }).notNull(),
    value: text("value").notNull(),
    label: text("label").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.kind, table.value] })],
);

export const legacyCountedFiles = sqliteTable(
  "counted_files",
  {
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    file: text("file").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.sessionId, table.file] })],
);

export const legacyBoardMessages = sqliteTable(
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

export const legacyBoardPickups = sqliteTable(
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
