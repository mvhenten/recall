import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

// A web MCP client that registered itself under RFC 7591. It carries no secret: a client running
// in a browser can keep none, so what binds a redemption is the code and the PKCE verifier, and
// `redirect_uris` is the one thing registration decides.
//
// Registration takes no credential, so the table is swept by the registration that follows: a row
// older than an hour holding neither a token nor a pending request is one no client ever carried
// through a sign-in, and it goes. A client that did carry one through holds a refresh token for a
// month, and the row stands as long as any of its tokens do.
export const oauthClients = sqliteTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  clientName: text("client_name").notNull(),
  redirectUris: text("redirect_uris").notNull(),
  createdAt: integer("created_at").notNull(),
});

// One authorize address, held while the user signs in to Access and decides. It exists so the
// consent page carries an id and not the client's own parameters: nothing the browser posts back
// decides which client, which callback or which challenge the code is bound to. A request nobody
// completes is swept by the next one that starts.
//
// `redirect_uri` is the address the authorize step resolved, never the raw parameter, so the token
// endpoint has one value to compare against and no case where it compares nothing. `state` is
// RECOMMENDED and not required, so whether the client sent one is its own column: a client that
// sent the empty string is echoed the empty string, and one that sent none is echoed nothing.
export const oauthRequests = sqliteTable("oauth_requests", {
  requestId: text("request_id").primaryKey(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  state: text("state").notNull(),
  stateSent: integer("state_sent").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

// An authorization code, as its SHA-256. It is spent by the delete that reads it, so a replay
// finds nothing; the row names the account that consented and the challenge the verifier has to
// answer to.
export const oauthCodes = sqliteTable("oauth_codes", {
  codeSha256: text("code_sha256").primaryKey(),
  clientId: text("client_id").notNull(),
  userId: text("user_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

// The tokens the connector issued, as digests. They are opaque rather than signed, so `/mcp` reads
// one by looking it up and a revoke is a delete; `kind` separates the hour-long access token from
// the month-long refresh token it is rotated with. A row names the account and the client and no
// audience: one deployment serves one connector endpoint, so there is no second resource a token
// of this table could have been minted for.
export const oauthTokens = sqliteTable("oauth_tokens", {
  tokenSha256: text("token_sha256").primaryKey(),
  clientId: text("client_id").notNull(),
  userId: text("user_id").notNull(),
  kind: text("kind", { enum: ["access", "refresh"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
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
