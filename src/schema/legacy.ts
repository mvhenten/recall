import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { vector } from "./columns";

// D1's artifact and memory tables, as `migrations/0012_artifacts.sql` and `migrations/0001_init.sql`
// left them. They are out of `./account` because no request path reads them any more:
// `../artifact-copy` and `../memory-copy` are their one reader each, and each copies what they
// hold into the account's own object. `migrations/0022_artifact_names.sql` says why the rows stay
// where they are, and step E of #115 is what takes the tables away.
//
// None is in `drizzle.config.ts`, so drizzle-kit neither sees them nor writes a migration for
// them. The one artifact column that differs from the tenant's copy is `last_writer_user_id`,
// which the copy resolves to an address through `principals`; the memory tables are column for
// column what the tenant object now holds.

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
