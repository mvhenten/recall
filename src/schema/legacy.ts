import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// D1's artifact tables, as `migrations/0012_artifacts.sql` left them. They are out of `./account`
// because no request path reads them any more: `../artifact-copy` is their one reader, and it
// copies what they hold into each account's own object. `migrations/0022_artifact_names.sql` says
// why the rows stay where they are, and step E of #115 is what takes the tables away.
//
// Neither is in `drizzle.config.ts`, so drizzle-kit neither sees them nor writes a migration for
// them. The one column that differs from the tenant's copy is `last_writer_user_id`, which the
// copy resolves to an address through `principals`.

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
