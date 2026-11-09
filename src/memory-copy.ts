import { and, asc, count, eq, gt, or, sql } from "drizzle-orm";
import type { AccountDb, TenantDb } from "./db";
import type { Embedder, Mode } from "./model";
import { memoryTypes } from "./model";
import { dot, ftsQuery, reciprocalRankFusion } from "./rank";
import { toBytes } from "./schema/columns";
import { memoriesFts } from "./schema/fts";
import { legacyMemories, legacyMemoryTags } from "./schema/legacy";
import { memories, memoryTags } from "./schema/tenant";
import { type TextCandidate, textCandidates, type VectorCandidate, vectorCandidates } from "./store";

// The one-shot copy of an account's memories out of D1 and into that account's own object, driven
// by `POST /v2/memories/copy` and by nothing else. It is not a request path: no read or write of a
// memory reaches anything here, and the route exists so that an operator can run the copy once
// against a running deployment.
//
// The corpus is the one store recall cannot rebuild. A transcript is still on the host that wrote
// it and `recall sessions --backfill` sends it again; a published artifact's bytes are still in R2
// and both stores address them the same way; a memory is its row and nothing else, in one place.
//
// The D1 rows are left exactly as they are, which is what keeps a rollback reading them.

// How many rows one read of D1 takes, how deep a ranking is compared and how many words the
// ranking is replayed with. All three bound the work of one call rather than the size of the data.
const READ_PAGE = 200;
const RANK_LIMIT = 50;
const MAX_QUERIES = 20;
const TOKEN = /[a-z0-9]{3,}/g;

const MODES: readonly Mode[] = ["hybrid", "vector", "text"];

export interface MemoryCopyChecks {
  // The row count on each side. The object may hold more: a memory saved after the deployment cut
  // over is the object's alone.
  rows: { account: number; tenant: number };
  // The tag pairs each side holds, which is what says a second run wrote no second tag.
  tags: { account: number; tenant: number };
  // Memory ids D1 holds that the object does not. Anything here is a memory that did not arrive.
  missing: string[];
  // Memory ids the object holds that D1 does not, which a save after the cutover accounts for.
  extra: string[];
  // Tag pairs, as `<memory id>/<tag>`, that D1 holds against a copied memory and the object does
  // not.
  missingTags: string[];
  // The memories whose embedding does not come back out of the object as the bytes D1 holds. A
  // vector is quantized int8, so one re-encoded byte moves every score computed from it.
  embeddings: string[];
  // What SQLite makes of `memories_fts` against `memories`, empty when the two agree. This is the
  // one thing a replayed ranking cannot see: `makeRoom` writes index entries by hand, and one left
  // behind at a mover's old rowid answers a later query with the copied memory that now holds it —
  // a memory the comparison leaves out, because D1 never ranked the mover at all.
  index: string;
  queries: number;
  // The queries whose ranked memory ids differ between the two stores, written `<mode>/<word>` and
  // `<mode>/<word> in <tag>` for the ones a tag scopes.
  ranking: string[];
  // Whether the corpus is accounted for. It also covers the memories passed over, which arrived
  // nowhere: D1 holds the only copy of their prose, so dropping those rows is a decision an
  // operator makes and not one a verified run can carry.
  ok: boolean;
}

export interface MemoryCopyReport {
  userId: string;
  memories: { copied: number; held: number; superseded: string[] };
  tags: { copied: number; held: number };
  // The memories the object wrote after the cutover whose `memory_seq` stood where a D1 memory's
  // belongs, moved above the whole of D1's range so that every copied row keeps its own.
  moved: string[];
  checks: MemoryCopyChecks;
}

interface LegacyMemory {
  memorySeq: number;
  memoryId: string;
  name: string;
  description: string;
  type: (typeof memoryTypes)[number];
  body: string;
  embedding: Uint8Array;
  createdAt: number;
  updatedAt: number;
  recallCount: number;
  lastRecalledAt: number;
}

type LegacyRow = [number, string, string, string, string, string, unknown, number, number, number, number];

const memoryTypeOf = (value: string): (typeof memoryTypes)[number] => {
  const known = memoryTypes.find((type) => type === value);
  if (known === undefined) throw new Error(`D1 holds a memory of unknown type ${value}`);
  return known;
};

// One account's D1 memories, read a page at a time by the key the copy preserves, so the size of
// the account rather than the size of one response decides how many reads it takes. The rows come
// back positional because the embedding is a blob the driver hands over in a shape of its own
// choosing — an ArrayBuffer in production, a number array under a miniflare build — and `toBytes`
// is the one place that is settled.
const accountMemories = async (db: AccountDb, userId: string): Promise<LegacyMemory[]> => {
  const rows: LegacyMemory[] = [];
  let after = 0;
  for (;;) {
    const page = await db.values<LegacyRow>(sql`
      SELECT ${legacyMemories.memorySeq}, ${legacyMemories.memoryId}, ${legacyMemories.name},
        ${legacyMemories.description}, ${legacyMemories.type}, ${legacyMemories.body},
        ${legacyMemories.embedding}, ${legacyMemories.createdAt}, ${legacyMemories.updatedAt},
        ${legacyMemories.recallCount}, ${legacyMemories.lastRecalledAt}
      FROM ${legacyMemories}
      WHERE ${legacyMemories.userId} = ${userId} AND ${legacyMemories.memorySeq} > ${after}
      ORDER BY ${legacyMemories.memorySeq} LIMIT ${READ_PAGE}`);
    for (const row of page) {
      rows.push({
        memorySeq: row[0],
        memoryId: row[1],
        name: row[2],
        description: row[3],
        type: memoryTypeOf(row[4]),
        body: row[5],
        embedding: toBytes(row[6]),
        createdAt: row[7],
        updatedAt: row[8],
        recallCount: row[9],
        lastRecalledAt: row[10],
      });
    }
    const last = page.at(-1);
    if (last === undefined || page.length < READ_PAGE) return rows;
    after = last[0];
  }
};

interface Tag {
  memoryId: string;
  tag: string;
}

const accountTags = async (db: AccountDb, userId: string): Promise<Tag[]> => {
  const rows: Tag[] = [];
  let afterId = "";
  let afterTag = "";
  for (;;) {
    const page = await db
      .select({ memoryId: legacyMemoryTags.memoryId, tag: legacyMemoryTags.tag })
      .from(legacyMemoryTags)
      .innerJoin(legacyMemories, eq(legacyMemories.memoryId, legacyMemoryTags.memoryId))
      .where(
        and(
          eq(legacyMemories.userId, userId),
          or(
            gt(legacyMemoryTags.memoryId, afterId),
            and(eq(legacyMemoryTags.memoryId, afterId), gt(legacyMemoryTags.tag, afterTag)),
          ),
        ),
      )
      .orderBy(asc(legacyMemoryTags.memoryId), asc(legacyMemoryTags.tag))
      .limit(READ_PAGE)
      .all();
    rows.push(...page);
    const last = page.at(-1);
    if (last === undefined || page.length < READ_PAGE) return rows;
    afterId = last.memoryId;
    afterTag = last.tag;
  }
};

interface HeldMemory {
  memorySeq: number;
  memoryId: string;
  name: string;
  description: string;
  body: string;
}

const tenantMemories = (db: TenantDb, userId: string): HeldMemory[] =>
  db
    .select({
      memorySeq: memories.memorySeq,
      memoryId: memories.memoryId,
      name: memories.name,
      description: memories.description,
      body: memories.body,
    })
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(asc(memories.memorySeq))
    .all();

// The room a copied row needs. A memory saved between the deployment and this run took the lowest
// free `memory_seq` the object had, which is a number D1 handed out years ago to another memory;
// the copy cannot renumber the one it is bringing over, so the one already here moves instead.
//
// `memory_seq` is `memories_fts`'s `content_rowid` and the update trigger only fires on the three
// indexed columns, so the index entry is moved here by hand: left behind, it would answer a later
// query with a rowid that by then names a copied memory.
//
// A row an earlier run already brought over sits inside D1's range by design and is left alone,
// which is what makes a second run move nothing.
const makeRoom = (
  db: TenantDb,
  userId: string,
  held: readonly HeldMemory[],
  copied: ReadonlySet<string>,
  highest: number,
): string[] => {
  const moving = held.filter((row) => row.memorySeq <= highest && !copied.has(row.memoryId));
  if (moving.length === 0) return [];
  // Above every key either store has handed out, so no mover lands on a row that has not moved
  // and the movers keep their order among themselves.
  let next = Math.max(highest, held.at(-1)?.memorySeq ?? 0) + 1;
  db.transaction((tx) => {
    for (const row of moving) {
      const to = next;
      next += 1;
      tx.run(
        sql`INSERT INTO ${memoriesFts} (${memoriesFts}, rowid, name, description, body)
          VALUES ('delete', ${row.memorySeq}, ${row.name}, ${row.description}, ${row.body})`,
      );
      tx.update(memories)
        .set({ memorySeq: to })
        .where(and(eq(memories.userId, userId), eq(memories.memorySeq, row.memorySeq)))
        .run();
      tx.run(
        sql`INSERT INTO ${memoriesFts} (rowid, name, description, body)
          VALUES (${to}, ${row.name}, ${row.description}, ${row.body})`,
      );
    }
  });
  return moving.map((row) => row.memoryId).sort();
};

// The rows, written with the key they came in under and in the order it counts out. `memory_seq`
// is `memories_fts`'s `content_rowid`: bm25 scores two rows of one query alike and leaves the
// rowid to settle them, so a re-numbered corpus answers the same query in another order with
// nothing failing anywhere. A memory the object already holds is left exactly as it stands, which
// is what makes a second run cost nothing.
const copyMemoryRows = (
  db: TenantDb,
  userId: string,
  rows: readonly LegacyMemory[],
  held: readonly HeldMemory[],
): { copied: number; superseded: string[] } => {
  const heldIds = new Set(held.map((row) => row.memoryId));
  const heldNames = new Set(held.map((row) => row.name));
  // A name the object already holds under another id is a memory saved after the cutover, and the
  // save is the later truth: the D1 row is passed over rather than written over it.
  const superseded = rows.filter((row) => !heldIds.has(row.memoryId) && heldNames.has(row.name));
  const taking = rows.filter((row) => !heldIds.has(row.memoryId) && !heldNames.has(row.name));
  if (taking.length === 0) return { copied: 0, superseded: superseded.map((row) => row.memoryId).sort() };
  let copied = 0;
  // One statement per row, never one insert of many, for the hundred-parameter ceiling.
  db.transaction((tx) => {
    for (const row of taking) {
      copied += tx
        .insert(memories)
        .values({
          memorySeq: row.memorySeq,
          memoryId: row.memoryId,
          userId,
          name: row.name,
          description: row.description,
          type: row.type,
          body: row.body,
          embedding: row.embedding,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          recallCount: row.recallCount,
          lastRecalledAt: row.lastRecalledAt,
        })
        .onConflictDoNothing()
        .returning({ memoryId: memories.memoryId })
        .all().length;
    }
  });
  return { copied, superseded: superseded.map((row) => row.memoryId).sort() };
};

// The tags of the memories that arrived. A tag of a memory the object does not hold is left
// behind with it, since the row it hangs off is what the foreign key names.
const copyTagRows = (db: TenantDb, userId: string, tags: readonly Tag[]): { copied: number; held: number } => {
  const owned = new Set(tenantMemories(db, userId).map((row) => row.memoryId));
  const taking = tags.filter((tag) => owned.has(tag.memoryId));
  if (taking.length === 0) return { copied: 0, held: 0 };
  let copied = 0;
  db.transaction((tx) => {
    for (const tag of taking) {
      copied += tx.insert(memoryTags).values(tag).onConflictDoNothing().returning({ tag: memoryTags.tag }).all().length;
    }
  });
  return { copied, held: taking.length - copied };
};

const tenantTagCount = (db: TenantDb, userId: string): number =>
  db
    .select({ n: count() })
    .from(memoryTags)
    .innerJoin(memories, eq(memories.memoryId, memoryTags.memoryId))
    .where(eq(memories.userId, userId))
    .get()?.n ?? 0;

const tenantEmbeddings = (db: TenantDb, userId: string): Map<string, Uint8Array> =>
  new Map(
    db
      .values<[string, unknown]>(
        sql`SELECT ${memories.memoryId}, ${memories.embedding} FROM ${memories}
          WHERE ${memories.userId} = ${userId}`,
      )
      .map(([memoryId, embedding]): [string, Uint8Array] => [memoryId, toBytes(embedding)]),
  );

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

// SQLite's own read of the index the copy hand-writes. `rank` is the argument that makes
// `integrity-check` an external-content check: at 0, and with no argument at all, it only reads
// the index against itself and a term under a rowid `memories` does not carry passes. At 1 it
// rebuilds what `memories` implies and holds the two against each other, raising
// SQLITE_CORRUPT_VTAB either way round — a term no row carries, a row whose terms are not indexed.
//
// Caught rather than thrown, so a corrupt index is reported with the rest of the checks instead of
// ending the run as a failed request that says nothing about any of them.
const indexIntegrity = (db: TenantDb): string => {
  try {
    db.run(sql`INSERT INTO ${memoriesFts} (${memoriesFts}, rank) VALUES ('integrity-check', 1)`);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

// The two filters the shipped reader scopes a search with, against D1's copy of the tables. They
// render the same SQL the tenant's do — the table and column names never changed — but the two
// handles refuse each other in the type system, which is the point.
const legacyTagFilter = (tags: readonly string[]): ReturnType<typeof sql> =>
  sql`(json_array_length(${JSON.stringify(tags)}) = 0 OR EXISTS (
    SELECT 1 FROM ${legacyMemoryTags}
    WHERE ${legacyMemoryTags.memoryId} = ${legacyMemories.memoryId}
      AND ${legacyMemoryTags.tag} IN (SELECT value FROM json_each(${JSON.stringify(tags)}))))`;

const accountVectorCandidates = async (db: AccountDb, userId: string, tags: string[]): Promise<VectorCandidate[]> => {
  const rows = await db.values<[string, unknown, number]>(sql`
    SELECT ${legacyMemories.memoryId}, ${legacyMemories.embedding}, ${legacyTagFilter(tags)}
    FROM ${legacyMemories} WHERE ${legacyMemories.userId} = ${userId}`);
  return rows.map(([memoryId, embedding, inScope]) => ({
    memoryId,
    embedding: toBytes(embedding),
    inScope: inScope === 1,
  }));
};

const accountTextCandidates = async (
  db: AccountDb,
  userId: string,
  tags: string[],
  query: string,
): Promise<TextCandidate[]> => {
  const rows = await db
    .select({ memoryId: legacyMemories.memoryId, inScope: legacyTagFilter(tags).mapWith(Number).as("in_scope") })
    .from(memoriesFts)
    .innerJoin(legacyMemories, eq(legacyMemories.memorySeq, memoriesFts.rowid))
    .where(and(sql`${memoriesFts} MATCH ${query}`, eq(legacyMemories.userId, userId)))
    .orderBy(sql`in_scope DESC, bm25(${memoriesFts}, 5.0, 2.0, 1.0)`)
    .limit(RANK_LIMIT)
    .all();
  return rows.map((row) => ({ memoryId: row.memoryId, inScope: row.inScope === 1 }));
};

// One side of the comparison: the two candidate reads a search makes, against one store. The
// ranking itself is computed once, below, off whichever pair of reads it is handed — the question
// is whether two stores answer one query with one order, and two implementations of the ranking
// could not answer it.
interface Side {
  vectors(tags: string[]): Promise<VectorCandidate[]>;
  text(tags: string[], match: string): Promise<TextCandidate[]>;
}

// Ties are settled on the memory id rather than left to whichever order the rows came back in.
// Two stores holding one corpus score it identically, so an order that moves under a tie would be
// the comparison's own noise and not a finding.
const byScore = (scored: Array<[string, number]>): string[] =>
  [...scored]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, RANK_LIMIT)
    .map(([memoryId]) => memoryId);

const vectorRanking = (candidates: readonly VectorCandidate[], query: Float32Array): string[] =>
  byScore(
    candidates.filter((one) => one.inScope).map((one): [string, number] => [one.memoryId, dot(query, one.embedding)]),
  );

const rankedIds = async (
  side: Side,
  candidates: readonly VectorCandidate[],
  tags: string[],
  match: string,
  query: Float32Array,
  mode: Mode,
  shared: ReadonlySet<string>,
): Promise<string[]> => {
  if (mode === "vector") return vectorRanking(candidates, query);
  const text = (await side.text(tags, match))
    .filter((one) => one.inScope && shared.has(one.memoryId))
    .map((one) => one.memoryId);
  if (mode === "text") return reciprocalRankFusion([text]).map(([memoryId]) => memoryId);
  return reciprocalRankFusion([vectorRanking(candidates, query), text])
    .slice(0, RANK_LIMIT)
    .map(([memoryId]) => memoryId);
};

// What the ranking is replayed with: every word of every name and description the account holds,
// as a phrase each. One word at a time is deliberate. bm25 weighs a term by how rare it is across
// the index, and D1's index holds every account's memories where the object's holds one account's
// — so the scores differ between the two stores whatever the copy does. For a single term that
// difference is one factor applied to every row alike and the order is untouched, which is what
// makes a ranked comparison across the two stores mean anything.
//
// Which twenty is spread across the sorted set rather than taken off its front, because the front
// of an alphabetical corpus is digits and `a`. It remains a sample: the embedding bytes and the id
// sets are what account for the corpus, and the ranking says the order survived for the words it
// was replayed with.
const queriesFor = (rows: readonly LegacyMemory[]): string[] => {
  const words = new Set<string>();
  for (const row of rows) {
    for (const word of `${row.name} ${row.description}`.toLowerCase().match(TOKEN) ?? []) words.add(word);
  }
  const sorted = [...words].sort();
  if (sorted.length <= MAX_QUERIES) return sorted;
  const step = sorted.length / MAX_QUERIES;
  return Array.from({ length: MAX_QUERIES }, (_, nth) => sorted[Math.floor(nth * step)]).filter(
    (word): word is string => word !== undefined,
  );
};

// The scopes a query is replayed under: no tag, and the first tag the account uses. A tagged query
// ranks in-scope memories ahead of the rest, so the two together cover both of the orders the
// reader can be served.
const scopesFor = (tags: readonly Tag[]): string[][] => {
  const named = [...new Set(tags.map((tag) => tag.tag))].sort();
  const first = named[0];
  return first === undefined ? [[]] : [[], [first]];
};

// The ranking is compared over the memories both stores hold and no others. A memory saved after
// the cutover is the object's alone and ranks in its answers and in nothing D1 can answer, so
// leaving it in would read as a difference the copy caused. What is under test is whether the
// corpus that crossed comes back in the order it went in.
const rankingChecks = async (
  account: AccountDb,
  tenant: TenantDb,
  userId: string,
  rows: readonly LegacyMemory[],
  tags: readonly Tag[],
  shared: ReadonlySet<string>,
  extra: number,
  embedder: Embedder,
): Promise<{ queries: number; ranking: string[] }> => {
  const words = queriesFor(rows);
  if (words.length === 0) return { queries: 0, ranking: [] };
  const vectors = await embedder.embed(words);
  const accountSide: Side = {
    vectors: (scope) => accountVectorCandidates(account, userId, scope),
    text: (scope, match) => accountTextCandidates(account, userId, scope, match),
  };
  const tenantSide: Side = {
    vectors: (scope) => vectorCandidates(tenant, userId, scope, []),
    // The object's own post-cutover rows match too and are dropped below, after the limit has
    // already counted them. Read that many deeper, or a corpus with more matches than the limit
    // reports a difference the copy did not make.
    text: (scope, match) => textCandidates(tenant, userId, scope, [], match, RANK_LIMIT + extra),
  };
  const ranking: string[] = [];
  let replayed = 0;
  for (const scope of scopesFor(tags)) {
    const held = {
      account: (await accountSide.vectors(scope)).filter((one) => shared.has(one.memoryId)),
      tenant: (await tenantSide.vectors(scope)).filter((one) => shared.has(one.memoryId)),
    };
    for (const [index, word] of words.entries()) {
      const match = ftsQuery(word);
      const query = vectors[index];
      if (match === null || query === undefined) continue;
      for (const mode of MODES) {
        const was = await rankedIds(accountSide, held.account, scope, match, query, mode, shared);
        const is = await rankedIds(tenantSide, held.tenant, scope, match, query, mode, shared);
        replayed += 1;
        const named = scope.length === 0 ? `${mode}/${word}` : `${mode}/${word} in ${scope.join(",")}`;
        if (was.join(",") !== is.join(",")) ranking.push(named);
      }
    }
  }
  return { queries: replayed, ranking };
};

const checksFor = async (
  account: AccountDb,
  tenant: TenantDb,
  userId: string,
  rows: readonly LegacyMemory[],
  tags: readonly Tag[],
  superseded: readonly string[],
  embedder: Embedder,
): Promise<MemoryCopyChecks> => {
  const held = tenantMemories(tenant, userId);
  const heldIds = new Set(held.map((row) => row.memoryId));
  const passedOver = new Set(superseded);
  const before = new Set(rows.map((row) => row.memoryId));
  const embeddings = tenantEmbeddings(tenant, userId);
  const heldTags = new Set(
    tenant
      .select({ memoryId: memoryTags.memoryId, tag: memoryTags.tag })
      .from(memoryTags)
      .innerJoin(memories, eq(memories.memoryId, memoryTags.memoryId))
      .where(eq(memories.userId, userId))
      .all()
      .map((row) => `${row.memoryId}/${row.tag}`),
  );
  const missing = rows
    .filter((row) => !heldIds.has(row.memoryId) && !passedOver.has(row.memoryId))
    .map((row) => row.memoryId)
    .sort();
  const mismatched = rows
    .filter((row) => heldIds.has(row.memoryId))
    .filter((row) => {
      const stored = embeddings.get(row.memoryId);
      return stored === undefined || !sameBytes(stored, row.embedding);
    })
    .map((row) => row.memoryId)
    .sort();
  const missingTags = tags
    .filter((tag) => heldIds.has(tag.memoryId) && !heldTags.has(`${tag.memoryId}/${tag.tag}`))
    .map((tag) => `${tag.memoryId}/${tag.tag}`)
    .sort();
  const extra = held
    .filter((row) => !before.has(row.memoryId))
    .map((row) => row.memoryId)
    .sort();
  const shared = new Set(rows.filter((row) => heldIds.has(row.memoryId)).map((row) => row.memoryId));
  const index = indexIntegrity(tenant);
  const { queries, ranking } = await rankingChecks(account, tenant, userId, rows, tags, shared, extra.length, embedder);
  return {
    rows: { account: rows.length, tenant: held.length },
    tags: { account: tags.length, tenant: tenantTagCount(tenant, userId) },
    missing,
    extra,
    missingTags,
    embeddings: mismatched,
    index,
    queries,
    ranking,
    ok:
      missing.length === 0 &&
      missingTags.length === 0 &&
      mismatched.length === 0 &&
      index === "" &&
      superseded.length === 0 &&
      ranking.length === 0,
  };
};

// The copy, start to finish, for one account. Running it again copies nothing, because a memory
// the object already holds is left as it stands and a tag already written conflicts with itself,
// so an interrupted run is finished by the next one.
export const copyMemories = async (
  tenant: TenantDb,
  account: AccountDb,
  userId: string,
  embedder: Embedder,
): Promise<MemoryCopyReport> => {
  const rows = await accountMemories(account, userId);
  const tags = await accountTags(account, userId);
  const highest = rows.at(-1)?.memorySeq ?? 0;
  const fromD1 = new Set(rows.map((row) => row.memoryId));
  const moved = makeRoom(tenant, userId, tenantMemories(tenant, userId), fromD1, highest);
  const held = tenantMemories(tenant, userId);
  const heldIds = new Set(held.map((row) => row.memoryId));
  const { copied, superseded } = copyMemoryRows(tenant, userId, rows, held);
  return {
    userId,
    memories: { copied, held: rows.filter((row) => heldIds.has(row.memoryId)).length, superseded },
    tags: copyTagRows(tenant, userId, tags),
    moved,
    checks: await checksFor(account, tenant, userId, rows, tags, superseded, embedder),
  };
};
