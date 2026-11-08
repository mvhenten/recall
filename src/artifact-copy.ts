import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import type { AccountDb, TenantDb } from "./db";
import { artifactShares, principals } from "./schema/account";
import { artifactsFts } from "./schema/fts";
import { legacyArtifactRevisions, legacyArtifacts } from "./schema/legacy";
import { artifactRevisions, artifacts } from "./schema/tenant";
import { claimArtifactName } from "./store";

// The one-shot copy of an account's artifact metadata out of D1 and into that account's own
// object, driven by `POST /v1/artifacts/copy` and by nothing else. It is not a request path: no
// read or write of an artifact reaches anything here, and the route exists so that an operator
// can run the copy once against a running deployment.
//
// The bytes never move. They are in R2 under `<user id>/<name>/<rev>/<path>` and both stores
// address them the same way. What moves is the only half of an artifact nothing can rebuild: the
// rows. A transcript is on its host and `recall sessions --backfill` sends it again; an artifact's
// title, type, permissions, revision and file list exist in these rows and nowhere else.
//
// The D1 rows are left exactly as they are, which is what keeps a rollback reading them.

export interface ArtifactCopyChecks {
  // The row count on each side, which is the first thing to read and never the whole answer: the
  // object may hold names of its own, published after the deployment cut over.
  rows: { account: number; tenant: number };
  // Names D1 holds that the object does not. Anything here is an artifact that did not arrive.
  missing: string[];
  // Names the object holds that D1 does not, which a publish after the cutover accounts for.
  extra: string[];
  queries: number;
  // The queries whose ranked artifact ids differ between the two indexes.
  ranking: string[];
  shares: number;
  // The live shares whose artifact the object does not answer with what D1 answered with.
  resolution: string[];
  ok: boolean;
}

export interface ArtifactCopyReport {
  userId: string;
  artifacts: { copied: number; held: number };
  revisions: { copied: number; raised: number; held: number };
  names: { claimed: string[]; heldElsewhere: string[]; contested: string[] };
  checks: ArtifactCopyChecks;
}

// How many rows one read of D1 takes, and how deep a ranking is compared. Both bound the work of
// one call rather than the size of the data: the read pages and the ranking is the top of a list
// a reader would ever see.
const READ_PAGE = 200;
const RANK_LIMIT = 50;
const MAX_QUERIES = 50;
const TOKEN = /[a-z0-9]{3,}/g;

interface LegacyArtifact {
  artifactSeq: number;
  name: string;
  rev: number;
  type: "site" | "document" | "audio";
  title: string;
  description: string;
  readPerm: "private" | "account";
  writePerm: "owner" | "account";
  entryPath: string;
  files: string;
  fileCount: number;
  bytes: number;
  createdAt: number;
  updatedAt: number;
  lastWriterUserId: string;
}

const LEGACY_FIELDS = {
  artifactSeq: legacyArtifacts.artifactSeq,
  name: legacyArtifacts.name,
  rev: legacyArtifacts.rev,
  type: legacyArtifacts.type,
  title: legacyArtifacts.title,
  description: legacyArtifacts.description,
  readPerm: legacyArtifacts.readPerm,
  writePerm: legacyArtifacts.writePerm,
  entryPath: legacyArtifacts.entryPath,
  files: legacyArtifacts.files,
  fileCount: legacyArtifacts.fileCount,
  bytes: legacyArtifacts.bytes,
  createdAt: legacyArtifacts.createdAt,
  updatedAt: legacyArtifacts.updatedAt,
  lastWriterUserId: legacyArtifacts.lastWriterUserId,
};

// One account's D1 artifact rows, read a page at a time by the key the copy preserves, so the
// size of the account rather than the size of one response decides how many reads it takes.
const accountArtifacts = async (db: AccountDb, userId: string): Promise<LegacyArtifact[]> => {
  const rows: LegacyArtifact[] = [];
  let after = 0;
  for (;;) {
    const page = await db
      .select(LEGACY_FIELDS)
      .from(legacyArtifacts)
      .where(and(eq(legacyArtifacts.userId, userId), gt(legacyArtifacts.artifactSeq, after)))
      .orderBy(asc(legacyArtifacts.artifactSeq))
      .limit(READ_PAGE)
      .all();
    rows.push(...page);
    const last = page.at(-1);
    if (last === undefined || page.length < READ_PAGE) return rows;
    after = last.artifactSeq;
  }
};

const accountRevisions = async (db: AccountDb, userId: string): Promise<Array<{ name: string; revNext: number }>> => {
  const rows: Array<{ name: string; revNext: number }> = [];
  let after = "";
  for (;;) {
    const page = await db
      .select({ name: legacyArtifactRevisions.name, revNext: legacyArtifactRevisions.revNext })
      .from(legacyArtifactRevisions)
      .where(and(eq(legacyArtifactRevisions.userId, userId), gt(legacyArtifactRevisions.name, after)))
      .orderBy(asc(legacyArtifactRevisions.name))
      .limit(READ_PAGE)
      .all();
    rows.push(...page);
    const last = page.at(-1);
    if (last === undefined || page.length < READ_PAGE) return rows;
    after = last.name;
  }
};

// Which address wrote each revision. D1 kept the writer as a user id and resolved it through
// `principals` on every read; the tenant row carries the address itself, so the copy resolves it
// once. An account whose addresses have all been withdrawn names none, which is the empty string
// the row already carries for it.
const writerAddresses = async (db: AccountDb): Promise<Map<string, string>> => {
  const rows = await db
    .select({ userId: principals.userId, email: sql<string>`min(${principals.email})` })
    .from(principals)
    .groupBy(principals.userId)
    .all();
  return new Map(rows.map((row) => [row.userId, row.email]));
};

// The names more than one account publishes for the whole account to read. The hostname has no
// user segment, so two of them are two artifacts at one address, and the resolver this replaces
// chose between them by user id. Nothing here chooses: the claim is left unmade, both accounts
// keep reaching their own artifact through their own object, and the report names what an
// operator has to settle.
const contestedNames = async (db: AccountDb): Promise<Set<string>> => {
  const rows = await db
    .select({ name: legacyArtifacts.name })
    .from(legacyArtifacts)
    .where(eq(legacyArtifacts.readPerm, "account"))
    .groupBy(legacyArtifacts.name)
    .having(sql`count(DISTINCT ${legacyArtifacts.userId}) > 1`)
    .all();
  return new Set(rows.map((row) => row.name));
};

const tenantNames = (db: TenantDb, userId: string): Map<string, number> =>
  new Map(
    db
      .select({ name: artifacts.name, artifactSeq: artifacts.artifactSeq })
      .from(artifacts)
      .where(eq(artifacts.userId, userId))
      .all()
      .map((row) => [row.name, row.artifactSeq]),
  );

// The rows, written with the key they came in under. `artifact_seq` is `artifacts_fts`'s
// `content_rowid`, so a re-numbered copy ranks the same query differently among rows bm25 scores
// alike; keeping it is what makes the two indexes comparable at all. A name the object already
// holds is left exactly as it stands, which is what makes a second run cost nothing.
const copyArtifactRows = (
  db: TenantDb,
  userId: string,
  rows: readonly LegacyArtifact[],
  writers: Map<string, string>,
): string[] => {
  const held = tenantNames(db, userId);
  const taking = rows.filter((row) => !held.has(row.name));
  if (taking.length === 0) return [];
  const written: string[] = [];
  // One statement per row, never one insert of many, for the hundred-parameter ceiling.
  db.transaction((tx) => {
    for (const row of taking) {
      const landed = tx
        .insert(artifacts)
        .values({
          artifactSeq: row.artifactSeq,
          userId,
          name: row.name,
          rev: row.rev,
          type: row.type,
          title: row.title,
          description: row.description,
          readPerm: row.readPerm,
          writePerm: row.writePerm,
          entryPath: row.entryPath,
          files: row.files,
          fileCount: row.fileCount,
          bytes: row.bytes,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastWriter: writers.get(row.lastWriterUserId) ?? "",
        })
        .onConflictDoNothing()
        .returning({ name: artifacts.name })
        .all();
      written.push(...landed.map((one) => one.name));
    }
  });
  return written;
};

// The revision counters. They never go back, so a name the object already counts from is raised
// to whichever of the two is further on rather than left or overwritten: a publish made after the
// cutover must not be handed a revision a D1-era publish already streamed bytes into.
const copyRevisionRows = (
  db: TenantDb,
  userId: string,
  rows: ReadonlyArray<{ name: string; revNext: number }>,
): { copied: number; raised: number; held: number } => {
  const held = new Map(
    db
      .select({ name: artifactRevisions.name, revNext: artifactRevisions.revNext })
      .from(artifactRevisions)
      .where(eq(artifactRevisions.userId, userId))
      .all()
      .map((row) => [row.name, row.revNext]),
  );
  const tally = { copied: 0, raised: 0, held: 0 };
  for (const row of rows) {
    const standing = held.get(row.name);
    if (standing === undefined) tally.copied += 1;
    else if (standing < row.revNext) tally.raised += 1;
    else tally.held += 1;
  }
  if (tally.copied === 0 && tally.raised === 0) return tally;
  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(artifactRevisions)
        .values({ userId, name: row.name, revNext: row.revNext })
        .onConflictDoUpdate({
          target: [artifactRevisions.userId, artifactRevisions.name],
          set: { revNext: sql`max(${artifactRevisions.revNext}, excluded.rev_next)` },
        })
        .run();
    }
  });
  return tally;
};

// The claim on each name, taken by the same rule a publish takes it by. A contested name is
// passed over outright. A private name the copy loses is no loss: a private artifact is reachable
// through its owner's own object and never through the claim.
const claimNames = async (
  db: AccountDb,
  userId: string,
  rows: readonly LegacyArtifact[],
  contested: Set<string>,
): Promise<{ claimed: string[]; heldElsewhere: string[]; contested: string[] }> => {
  const claimed: string[] = [];
  const heldElsewhere: string[] = [];
  const passed: string[] = [];
  for (const row of rows) {
    if (contested.has(row.name)) {
      passed.push(row.name);
      continue;
    }
    const took = await claimArtifactName(db, userId, row.name, row.readPerm);
    (took ? claimed : heldElsewhere).push(row.name);
  }
  return { claimed, heldElsewhere, contested: passed };
};

// What the ranking is replayed with: every word of every name and title the account published, as
// a phrase each. One word at a time is deliberate. bm25 weighs a term by how rare it is across the
// index, and D1's index holds every account's artifacts where the object's holds one account's —
// so the scores differ between the two stores whatever the copy does. For a single term that
// difference is one factor applied to every row alike and the order is untouched, which is what
// makes a ranked comparison across the two stores mean anything.
const queriesFor = (rows: readonly LegacyArtifact[]): string[] => {
  const words = new Set<string>();
  for (const row of rows) {
    for (const word of `${row.name} ${row.title}`.toLowerCase().match(TOKEN) ?? []) words.add(word);
  }
  return [...words].sort().slice(0, MAX_QUERIES);
};

const accountRanking = async (db: AccountDb, userId: string, match: string): Promise<number[]> => {
  const rows = await db
    .select({ artifactSeq: legacyArtifacts.artifactSeq })
    .from(artifactsFts)
    .innerJoin(legacyArtifacts, eq(legacyArtifacts.artifactSeq, artifactsFts.rowid))
    .where(and(sql`${artifactsFts} MATCH ${match}`, eq(legacyArtifacts.userId, userId)))
    .orderBy(sql`bm25(${artifactsFts}, 5.0, 2.0, 1.0)`)
    .limit(RANK_LIMIT)
    .all();
  return rows.map((row) => row.artifactSeq);
};

const tenantRanking = (db: TenantDb, userId: string, match: string): number[] =>
  db
    .select({ artifactSeq: artifacts.artifactSeq })
    .from(artifactsFts)
    .innerJoin(artifacts, eq(artifacts.artifactSeq, artifactsFts.rowid))
    .where(and(sql`${artifactsFts} MATCH ${match}`, eq(artifacts.userId, userId)))
    .orderBy(sql`bm25(${artifactsFts}, 5.0, 2.0, 1.0)`)
    .limit(RANK_LIMIT)
    .all()
    .map((row) => row.artifactSeq);

// Every live share of this account, against what it pointed at before. A share names its owner
// and its artifact's name and is resolved by reading that account's row directly, so this is the
// whole of what stands between a handed-out link and a dead one.
const shareResolution = async (
  account: AccountDb,
  tenant: TenantDb,
  userId: string,
  now: number,
  before: Map<string, LegacyArtifact>,
): Promise<{ shares: number; resolution: string[] }> => {
  const shares = await account
    .select({ shareId: artifactShares.shareId, name: artifactShares.name })
    .from(artifactShares)
    .where(and(eq(artifactShares.userId, userId), gt(artifactShares.expiresAt, now)))
    .all();
  const after = new Map(
    tenant
      .select({ name: artifacts.name, artifactSeq: artifacts.artifactSeq, rev: artifacts.rev })
      .from(artifacts)
      .where(eq(artifacts.userId, userId))
      .all()
      .map((row) => [row.name, row]),
  );
  const resolution = shares
    .filter((share) => {
      const was = before.get(share.name);
      const is = after.get(share.name);
      if (was === undefined) return is !== undefined;
      return is === undefined || is.artifactSeq !== was.artifactSeq || is.rev !== was.rev;
    })
    .map((share) => share.shareId);
  return { shares: shares.length, resolution };
};

const checksFor = async (
  account: AccountDb,
  tenant: TenantDb,
  userId: string,
  now: number,
  rows: readonly LegacyArtifact[],
): Promise<ArtifactCopyChecks> => {
  const before = new Map(rows.map((row) => [row.name, row]));
  const after = tenantNames(tenant, userId);
  const accountRows = await account
    .select({ n: count() })
    .from(legacyArtifacts)
    .where(eq(legacyArtifacts.userId, userId))
    .get();
  const queries = queriesFor(rows);
  const ranking: string[] = [];
  for (const word of queries) {
    const match = `"${word}"`;
    const was = await accountRanking(account, userId, match);
    const is = tenantRanking(tenant, userId, match);
    if (was.join(",") !== is.join(",")) ranking.push(word);
  }
  const { shares, resolution } = await shareResolution(account, tenant, userId, now, before);
  const missing = [...before.keys()].filter((name) => !after.has(name)).sort();
  const extra = [...after.keys()].filter((name) => !before.has(name)).sort();
  return {
    rows: { account: accountRows?.n ?? 0, tenant: after.size },
    missing,
    extra,
    queries: queries.length,
    ranking,
    shares,
    resolution,
    ok: missing.length === 0 && ranking.length === 0 && resolution.length === 0,
  };
};

// The copy, start to finish, for one account. Running it again copies nothing and claims what it
// claimed before, so an interrupted run is finished by the next one.
export const copyArtifacts = async (
  tenant: TenantDb,
  account: AccountDb,
  userId: string,
  now: number,
): Promise<ArtifactCopyReport> => {
  const rows = await accountArtifacts(account, userId);
  const held = tenantNames(tenant, userId);
  const writers = await writerAddresses(account);
  const copied = copyArtifactRows(tenant, userId, rows, writers);
  const revisions = copyRevisionRows(tenant, userId, await accountRevisions(account, userId));
  const names = await claimNames(account, userId, rows, await contestedNames(account));
  return {
    userId,
    artifacts: { copied: copied.length, held: rows.filter((row) => held.has(row.name)).length },
    revisions,
    names,
    checks: await checksFor(account, tenant, userId, now, rows),
  };
};
