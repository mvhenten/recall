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

// Which account a name on the artifact hostname belongs to. The hostname has no user segment, so
// the address space of names is the deployment's and not an account's: this row is the claim on
// one of them, and resolving a name is this one read followed by the owner's object.
//
// The claim is first come. An account-readable publish takes a free name, a name this account
// already holds, or one another account holds privately — it may not take a name another account
// publishes for the whole account to read, and that refusal is this table's primary key rather
// than a check a second publish can race. A private publish that finds the name held writes no
// row at all and is reachable through its owner's object alone, which is how two accounts keep
// private artifacts of one name.
//
// WITHOUT ROWID in `migrations/0022_artifact_names.sql`, which drizzle's schema cannot say.
export const artifactNames = sqliteTable("artifact_names", {
  name: text("name").primaryKey(),
  userId: text("user_id").notNull(),
  readPerm: text("read_perm", { enum: ["private", "account"] }).notNull(),
});

// Which account an Access service token acts for. It was a JSON object in the Worker's env, which
// made adding a tenant a config edit and a redeploy; it is a row so that it is a write.
//
// WITHOUT ROWID likewise.
export const mcpClients = sqliteTable("mcp_clients", {
  clientId: text("client_id").primaryKey(),
  userId: text("user_id").notNull(),
});

// WITHOUT ROWID in `migrations/0016_artifact_shares.sql`. It does not follow the artifacts into
// the tenant object: nothing joins a share to a tenant table, and splitting the routing from the
// metadata would make one revoke two writes against two stores.
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
