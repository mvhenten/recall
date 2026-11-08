import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { vector } from "./columns";

// The account's own tables, the ones a request reads before it knows which tenant it is for. The
// tenant's tables are in `./tenant` and nothing joins across the two.
//
// Tables and columns are all that lives here. Every index, every FTS5 table and every trigger is
// hand-written in `migrations/`, because drizzle's SQLite schema has no index direction and no
// virtual tables, and this store's keyset pages are served by DESC indexes.

export const principals = sqliteTable("principals", {
  email: text("email").primaryKey(),
  userId: text("user_id").notNull(),
});

export const memories = sqliteTable(
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

export const memoryTags = sqliteTable(
  "memory_tags",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.memoryId, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (table) => [primaryKey({ columns: [table.memoryId, table.tag] })],
);

export const deviceCodes = sqliteTable("device_codes", {
  deviceCodeSha256: text("device_code_sha256").primaryKey(),
  userCode: text("user_code").notNull().unique(),
  deviceName: text("device_name").notNull(),
  clientIp: text("client_ip").notNull(),
  status: text("status", { enum: ["pending", "approved", "denied"] }).notNull(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  intervalS: integer("interval_s").notNull(),
  lastPolledAt: integer("last_polled_at").notNull(),
});

export const devices = sqliteTable("devices", {
  deviceId: text("device_id").primaryKey(),
  tokenSha256: text("token_sha256").notNull().unique(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at").notNull(),
  host: text("host").notNull().default(""),
  kind: text("kind", { enum: ["host", "connector"] })
    .notNull()
    .default("host"),
});

export const artifacts = sqliteTable(
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

// WITHOUT ROWID in `migrations/0012_artifacts.sql`, which drizzle's schema cannot say.
export const artifactRevisions = sqliteTable(
  "artifact_revisions",
  {
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    revNext: integer("rev_next").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.name] })],
);

// WITHOUT ROWID in `migrations/0016_artifact_shares.sql`.
export const artifactShares = sqliteTable("artifact_shares", {
  shareId: text("share_id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  mode: text("mode", { enum: ["link", "email"] }).notNull(),
  subject: text("subject").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  lastUsedAt: integer("last_used_at").notNull(),
  uses: integer("uses").notNull(),
});
