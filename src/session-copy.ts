import { and, asc, eq, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { AccountDb, TenantDb, TenantTx } from "./db";
import { toBytes } from "./schema/columns";
import { sessionChunksFts, sessionHistoryFts } from "./schema/fts";
import {
  legacyBoardMessages,
  legacyBoardPickups,
  legacyCountedFiles,
  legacyLabels,
  legacySessionChunks,
  legacySessionHistory,
  legacySessionIndex,
  legacySessionOpenChunks,
  legacySessionRecords,
  legacySessions,
  legacyUsageDaily,
  legacyUsageEvents,
} from "./schema/legacy";
import {
  boardMessages,
  boardPickups,
  countedFiles,
  labels,
  sessionChunks,
  sessionHistory,
  sessionIndex,
  sessionOpenChunks,
  sessionRecords,
  sessions,
  usageDaily,
  usageEvents,
} from "./schema/tenant";
import { jsonEach, raiseChunkReach } from "./store";

// The one-shot copy of an account's sessions out of D1 and into that account's own object, driven
// by `POST /v1/sessions/copy` and by nothing else. It is not a request path: no read or write of a
// session reaches anything here, and the route exists so that an operator can run the copy against
// a running deployment.
//
// `migrations/tenant/0001_tenant.sql` moved the whole of a session into the object and copied no
// row, so every session the account held before the deployment is addressed at an object that has
// never heard of it: its page and its transcript both answer 404 while D1 still holds the rows and
// R2 still holds the archive. This brings the rows across. The bytes never move.
//
// The D1 rows are left exactly as they are, which is what keeps a rollback reading them. Nothing
// writes them any more either, which is why a page of one can be taken by offset: the side being
// read stands still for the whole run.

// How many rows one read of D1 takes. The chunk page is smaller because its rows carry the prose
// and a vector each, and bounds one response rather than the size of the account.
const READ_PAGE = 500;
const CHUNK_PAGE = 250;

// How many rows one batch writes into the object. Every batch is many single-row statements, never
// one insert of many rows, for the hundred-parameter ceiling on the object's SQLite.
const WRITE_BATCH = 200;

// How many chunks one call takes before it hands the frontier back. The prose is the half of this
// that can run to hundreds of megabytes and the only half whose cost is the embedding index, so a
// corpus too big for one request's budget is finished by the caller looping on `after` rather than
// by a run that dies and leaves the next one re-reading what it already copied.
const CHUNK_BUDGET = 5_000;

// A table of either store keyed by the account it belongs to, which every one of these is.
type Owned = SQLiteTable & { userId: SQLiteColumn };

// A column of that table and of no other, so an order cannot name one the query never reads.
type ColumnOf<T extends SQLiteTable> = T["_"]["columns"][keyof T["_"]["columns"]];

// What one table did, and what each store holds of it afterwards. The counts are the half the
// tallies cannot say: every insert of a table conflicting reads as `copied: 0, held: N`, which is
// exactly what a table that arrived twice over reads as too.
export interface TableReport {
  table: string;
  copied: number;
  held: number;
  account: number;
  tenant: number;
}

export interface SessionCopyChecks {
  // The tables the object holds fewer rows of than D1, which is what says a table did not arrive.
  // It may hold more of any of them: a session started after the cutover is its own.
  //
  // `session_chunks` is deliberately not among them. The object counts the prose it indexed itself
  // alongside the prose it was given, so an account whose own chunks outnumber D1's satisfies
  // `tenant >= account` having copied nothing at all. What accounts for the prose is how much of
  // D1's the run walked, which is `chunks.copied + chunks.held` summed over every call of it and
  // so is the caller's to add up — one call cannot see a run.
  short: string[];
  // Session ids D1 holds that the object does not.
  missing: string[];
  // Session ids the object holds that D1 does not, which a session started after the cutover
  // accounts for.
  extra: string[];
  // D1 chunks this call walked with no row in the object under the `chunk_seq` they were written
  // with. Like `embeddings`, it is this call's own and the caller sums it over the run.
  missingChunks: number;
  // The chunks this call wrote whose embedding does not come back out of the object as the bytes
  // D1 holds. A vector is quantized int8, so one re-encoded byte moves every score computed from
  // it. A chunk an earlier call brought over is left out: its vector was held against D1's then.
  embeddings: number[];
  // What SQLite makes of `session_chunks_fts` against `session_chunks`. The index is
  // external-content and the copy moves rowids by hand, so this is the one thing no count can
  // see: an entry left at a mover's old rowid answers a later query with the copied chunk that
  // now holds it.
  chunkIndex: IndexCheck;
  // The same read of `session_history_fts`, which stores its own copy of the text.
  historyIndex: IndexCheck;
  // What this call can account for, which is everything but how much of the prose the run has
  // walked. The caller holds that, and `npm run copy-sessions` is what adds it up.
  ok: boolean;
}

// What the integrity check made of an index, and whether the check ran at all. A statement that
// fails for any other reason leaves the index unread, which is not the same finding as an index
// and its rows disagreeing and does not read as one.
export interface IndexCheck {
  corrupt: boolean;
  error: string;
}

export interface SessionCopyReport {
  userId: string;
  // One per table the cutover moved, `session_chunks` last.
  tables: TableReport[];
  // Whether every table but the prose has been read out of D1 and written, which this report
  // existing is the proof of: the phase runs to its end before a response is built, so a call that
  // died in the middle of it answered nothing at all. A continuation is handed this back and skips
  // the phase on it. Nothing about the object says it — the object holds its own post-cutover rows
  // beside the copied ones, so a count of either table is satisfied without a D1 row having
  // crossed.
  metadata: { complete: boolean };
  chunks: {
    // What this call walked of D1's prose. The two together are how much of it this call accounts
    // for, and summed over the run they are what says the whole corpus crossed — the object's own
    // row count cannot say it, since the object holds the prose it indexed itself as well.
    copied: number;
    held: number;
    // How many chunks D1 holds for this account, so the caller has what to sum against.
    account: number;
    // The copied chunks that could not keep the ordinal D1 gave them, because the object already
    // indexes that ordinal of that session.
    shifted: number;
    // The object's own chunks moved up the sequence to free a `chunk_seq` a copied one came in
    // under.
    moved: number;
    // The `chunk_seq` this call read up to, which the next one is given as `after`.
    frontier: number;
    // Whether the frontier is the end of D1's chunks.
    done: boolean;
  };
  // The sessions both stores held when the run opened: the object's row is the later one and
  // stands, and what D1 holds of them that the object does not is added beside it. Only the call
  // that opens the run can say which those were, so a continuation names none.
  straddling: string[];
  checks: SessionCopyChecks;
}

// One page of a table nothing writes any more, taken by offset. A keyset walk would say the same
// thing against a still side and cost a composite comparison per table.
const allOf = async <T extends Owned>(
  db: AccountDb,
  table: T,
  userId: string,
  order: ReadonlyArray<ColumnOf<T>>,
): Promise<Array<T["$inferSelect"]>> => {
  const rows: Array<T["$inferSelect"]> = [];
  for (let offset = 0; ; offset += READ_PAGE) {
    const page = await db
      .select()
      .from(table)
      .where(eq(table.userId, userId))
      .orderBy(...order.map(asc))
      .limit(READ_PAGE)
      .offset(offset)
      .all();
    rows.push(...page);
    if (page.length < READ_PAGE) return rows;
  }
};

// The rows of one table, written one statement at a time and in batches the object commits whole.
// A row the object already holds conflicts with itself and is left exactly as it stands, which is
// what makes the object's row the one that wins and a second run cost nothing.
const copyTable = <T extends Owned>(db: TenantDb, table: T, rows: ReadonlyArray<T["$inferInsert"]>): number => {
  let copied = 0;
  for (let start = 0; start < rows.length; start += WRITE_BATCH) {
    const batch = rows.slice(start, start + WRITE_BATCH);
    db.transaction((tx) => {
      for (const row of batch) {
        // Whichever column is returned, what is read of it is that a row landed rather than
        // conflicting with one the object already holds.
        copied += tx.insert(table).values(row).onConflictDoNothing().returning({ owner: table.userId }).all().length;
      }
    });
  }
  return copied;
};

const accountCount = async (db: AccountDb, table: Owned, userId: string): Promise<number> => {
  const rows = await db.values<[number]>(sql`SELECT count(*) FROM ${table} WHERE ${table.userId} = ${userId}`);
  return rows[0]?.[0] ?? 0;
};

const tenantCount = (db: TenantDb, table: Owned, userId: string): number =>
  db.values<[number]>(sql`SELECT count(*) FROM ${table} WHERE ${table.userId} = ${userId}`)[0]?.[0] ?? 0;

interface LegacyChunk {
  chunkSeq: number;
  sessionId: string;
  ordinal: number;
  speaker: "user" | "model";
  text: string;
  embedding: Uint8Array;
  at: number;
}

// The speaker is read as the union both schemas hold the column to with a CHECK, the way a row
// shape is the caller's assertion everywhere `values` is used.
type ChunkRow = [number, string, number, "user" | "model", string, unknown, number];

// One page of the account's chunks, keyed by the sequence the copy preserves rather than by an
// offset, because this is the one table big enough for the walk to cost something. The rows come
// back positional because the embedding is a blob the driver hands over in a shape of its own
// choosing, and `toBytes` is the one place that is settled.
const accountChunkPage = async (db: AccountDb, userId: string, after: number): Promise<LegacyChunk[]> => {
  const page = await db.values<ChunkRow>(sql`
    SELECT ${legacySessionChunks.chunkSeq}, ${legacySessionChunks.sessionId}, ${legacySessionChunks.ordinal},
      ${legacySessionChunks.speaker}, ${legacySessionChunks.text}, ${legacySessionChunks.embedding},
      ${legacySessionChunks.at}
    FROM ${legacySessionChunks}
    WHERE ${legacySessionChunks.userId} = ${userId} AND ${legacySessionChunks.chunkSeq} > ${after}
    ORDER BY ${legacySessionChunks.chunkSeq} LIMIT ${CHUNK_PAGE}`);
  return page.map((row) => ({
    chunkSeq: row[0],
    sessionId: row[1],
    ordinal: row[2],
    speaker: row[3],
    text: row[4],
    embedding: toBytes(row[5]),
    at: row[6],
  }));
};

// What the copy carries from one page of chunks to the next.
interface ChunkState {
  copied: number;
  held: number;
  shifted: number;
  moved: number;
  missing: number;
  embeddings: number[];
  // The ordinal the next shifted chunk of a session takes.
  ordinals: Map<string, number>;
}

// Where one chunk ended up, and whether this run is what put it there.
interface Placed {
  ordinal: number;
  held: boolean;
}

// The object's own chunk, moved off a `chunk_seq` a copied one came in under. `chunk_seq` is
// `session_chunks_fts`'s `content_rowid` and nothing fires on an update of it — the triggers are
// an insert and a delete — so the index entry is moved here by hand. Left behind, it would answer
// a later query with the rowid that by then names a copied chunk.
//
// Moving up rather than renumbering the copy is also what keeps `chunk_seq` meaning recency: the
// vector scan bounds itself to the highest keys, and a chunk the object wrote after the cutover is
// the newest prose the account has.
//
// Where it moves to is read here rather than counted up from a number taken before the run: the
// object goes on serving its account while this runs, and a session archiving a stretch between
// two pages takes the next key for itself.
const moveChunk = (tx: TenantTx, userId: string, from: number, text: string, highest: number): void => {
  const top = tx
    .select({ top: sql<number>`COALESCE(MAX(${sessionChunks.chunkSeq}), 0)` })
    .from(sessionChunks)
    .where(eq(sessionChunks.userId, userId))
    .get();
  const to = Math.max(highest, top?.top ?? 0) + 1;
  tx.run(sql`INSERT INTO ${sessionChunksFts} (${sessionChunksFts}, rowid, text) VALUES ('delete', ${from}, ${text})`);
  tx.update(sessionChunks)
    .set({ chunkSeq: to })
    .where(and(eq(sessionChunks.userId, userId), eq(sessionChunks.chunkSeq, from)))
    .run();
  tx.run(sql`INSERT INTO ${sessionChunksFts} (rowid, text) VALUES (${to}, ${text})`);
};

// The ordinal a chunk takes when the one D1 gave it is already indexed. It climbs from whatever
// the session reaches, so the prose the object wrote after the cutover keeps the ordinals it was
// written under and nothing D1 holds is dropped for colliding with them.
const nextOrdinal = (tx: TenantTx, userId: string, sessionId: string, state: ChunkState): number => {
  const known = state.ordinals.get(sessionId);
  if (known !== undefined) {
    state.ordinals.set(sessionId, known + 1);
    return known;
  }
  const row = tx
    .select({ top: sql<number>`COALESCE(MAX(${sessionChunks.ordinal}), -1)` })
    .from(sessionChunks)
    .where(and(eq(sessionChunks.userId, userId), eq(sessionChunks.sessionId, sessionId)))
    .get();
  const start = (row?.top ?? -1) + 1;
  state.ordinals.set(sessionId, start + 1);
  return start;
};

// One chunk, written under the `chunk_seq` it came in with. The insert trigger writes its index
// entry, the way it does for every chunk the object indexes itself.
//
// Three things can stand in the way of it, and the row already at that key says which. A row of
// the same session carrying the same prose at the same instant is this chunk and is left alone.
// All three, rather than the session and the prose: `at` is the timestamp of the transcript entry
// the chunk opened on, so it separates two stretches of one session that happened to say the same
// thing from one chunk written twice. It is copied verbatim, so a second run still recognises its
// own work; `ordinal` cannot join it, because a shifted chunk does not keep the one it came in
// with.
//
// A row matching all three is the same chunk whoever wrote it, which is why passing it over loses
// nothing. A session replayed after the cutover is re-indexed from ordinal zero and writes the
// pre-cutover prose again under the low keys D1 handed this account, at the instants it already
// carried: those rows match, and the copy leaving them where they stand is right.
//
// A row that is not this chunk is the object's own and moves up. What is left is an ordinal of
// this session the object already indexes, which the chunk climbs past.
const placeChunk = (tx: TenantTx, userId: string, row: LegacyChunk, state: ChunkState, highest: number): Placed => {
  const values = {
    chunkSeq: row.chunkSeq,
    userId,
    sessionId: row.sessionId,
    ordinal: row.ordinal,
    speaker: row.speaker,
    text: row.text,
    embedding: row.embedding,
    at: row.at,
  };
  const landed = (ordinal: number): boolean =>
    tx
      .insert(sessionChunks)
      .values({ ...values, ordinal })
      .onConflictDoNothing()
      .returning({ chunkSeq: sessionChunks.chunkSeq })
      .all().length === 1;
  if (landed(row.ordinal)) {
    state.copied += 1;
    return { ordinal: row.ordinal, held: false };
  }
  const standing = tx
    .select({
      sessionId: sessionChunks.sessionId,
      ordinal: sessionChunks.ordinal,
      text: sessionChunks.text,
      at: sessionChunks.at,
    })
    .from(sessionChunks)
    .where(and(eq(sessionChunks.userId, userId), eq(sessionChunks.chunkSeq, row.chunkSeq)))
    .get();
  if (
    standing !== undefined &&
    standing.sessionId === row.sessionId &&
    standing.text === row.text &&
    standing.at === row.at
  ) {
    state.held += 1;
    return { ordinal: standing.ordinal, held: true };
  }
  if (standing !== undefined) {
    moveChunk(tx, userId, row.chunkSeq, standing.text, highest);
    state.moved += 1;
    if (landed(row.ordinal)) {
      state.copied += 1;
      return { ordinal: row.ordinal, held: false };
    }
  }
  const ordinal = nextOrdinal(tx, userId, row.sessionId, state);
  if (!landed(ordinal)) {
    throw new Error(`chunk ${row.chunkSeq} of session ${row.sessionId} found no free ordinal in the object`);
  }
  state.copied += 1;
  state.shifted += 1;
  return { ordinal, held: false };
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

// The page read back out of the object and held against the page that went in. It runs beside the
// copy rather than after it so that the vectors are compared while they are still in hand: a
// second pass over the whole corpus to check them would read every chunk out of D1 twice.
//
// Every row is asked for, and only the ones this run wrote are compared byte for byte. A chunk the
// object was already holding was embedded by whichever model was live when it was indexed, and a
// vector that differs for that reason is not this copy's doing.
const verifyChunkPage = (
  db: TenantDb,
  userId: string,
  page: readonly LegacyChunk[],
  placed: ReadonlyMap<number, Placed>,
  state: ChunkState,
): void => {
  const stored = new Map(
    db
      .values<[number, unknown]>(
        sql`SELECT ${sessionChunks.chunkSeq}, ${sessionChunks.embedding} FROM ${sessionChunks}
          WHERE ${sessionChunks.userId} = ${userId}
            AND ${sessionChunks.chunkSeq} IN ${jsonEach(page.map((row) => row.chunkSeq))}`,
      )
      .map(([chunkSeq, embedding]): [number, Uint8Array] => [chunkSeq, toBytes(embedding)]),
  );
  for (const row of page) {
    const got = stored.get(row.chunkSeq);
    if (got === undefined) {
      state.missing += 1;
      continue;
    }
    if (placed.get(row.chunkSeq)?.held === true) continue;
    if (!sameBytes(got, row.embedding)) state.embeddings.push(row.chunkSeq);
  }
};

interface ChunkPass extends ChunkState {
  frontier: number;
  done: boolean;
}

// The account's prose, a page at a time, so that neither the vectors nor the text of a corpus that
// runs to hundreds of megabytes is ever held whole. Each page is one batch, and the call stops on
// its budget and hands back the `chunk_seq` it read to, so a corpus bigger than one request walks
// forward over as many calls as it takes rather than restarting.
const copyChunks = async (
  tenant: TenantDb,
  account: AccountDb,
  userId: string,
  highest: number,
  after: number,
): Promise<ChunkPass> => {
  const state: ChunkState = {
    copied: 0,
    held: 0,
    shifted: 0,
    moved: 0,
    missing: 0,
    embeddings: [],
    ordinals: new Map(),
  };
  let frontier = after;
  let seen = 0;
  for (;;) {
    const page = await accountChunkPage(account, userId, frontier);
    if (page.length === 0) return { ...state, frontier, done: true };
    const reach = new Map<string, number>();
    const placed = new Map<number, Placed>();
    tenant.transaction((tx) => {
      for (const row of page) {
        const put = placeChunk(tx, userId, row, state, highest);
        placed.set(row.chunkSeq, put);
        reach.set(row.sessionId, Math.max(reach.get(row.sessionId) ?? 0, put.ordinal + 1));
      }
      for (const [sessionId, chunks] of reach) raiseChunkReach(tx, userId, sessionId, chunks);
    });
    verifyChunkPage(tenant, userId, page, placed, state);
    frontier = page[page.length - 1]?.chunkSeq ?? frontier;
    seen += page.length;
    if (page.length < CHUNK_PAGE) return { ...state, frontier, done: true };
    if (seen >= CHUNK_BUDGET) return { ...state, frontier, done: false };
  }
};

// SQLite's own read of an index against the rows it indexes. `rank` is the argument that makes
// `integrity-check` an external-content check, and `session_chunks_fts` needs it: with no argument
// at all it reads the index against itself, and a term under a rowid `session_chunks` does not
// carry passes. At 1 it rebuilds what `session_chunks` implies and holds the two against each
// other, raising SQLITE_CORRUPT_VTAB either way round.
//
// `session_history_fts` stores its own copy of the text and so has nothing external to be held
// against, which is the one-argument form.
//
// Caught rather than thrown, so a corrupt index is reported with the rest of the checks instead of
// ending the run as a failed request that says nothing about any of them. Corruption is the one
// class this names: a statement that fails for any other reason leaves the index unread, which is
// a different thing to tell an operator than an index that disagrees with its rows.
const indexIntegrity = (
  db: TenantDb,
  table: typeof sessionChunksFts | typeof sessionHistoryFts,
  rank: 0 | 1,
): IndexCheck => {
  try {
    db.run(
      rank === 1
        ? sql`INSERT INTO ${table} (${table}, rank) VALUES ('integrity-check', 1)`
        : sql`INSERT INTO ${table} (${table}) VALUES ('integrity-check')`,
    );
    return { corrupt: false, error: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { corrupt: /corrupt|malformed/i.test(message), error: message };
  }
};

// Every session a store knows of, live or over. Both halves are asked because a session ends by
// moving from one table to the other, and the copy is about whether the account can reach it.
const tenantSessionIds = (db: TenantDb, userId: string): Set<string> =>
  new Set(
    db
      .values<[string]>(
        sql`SELECT ${sessions.sessionId} FROM ${sessions} WHERE ${sessions.userId} = ${userId}
          UNION SELECT ${sessionHistory.sessionId} FROM ${sessionHistory}
            WHERE ${sessionHistory.userId} = ${userId}`,
      )
      .map(([sessionId]) => sessionId),
  );

const accountSessionIds = async (db: AccountDb, userId: string): Promise<Set<string>> => {
  const rows = await db.values<[string]>(
    sql`SELECT ${legacySessions.sessionId} FROM ${legacySessions} WHERE ${legacySessions.userId} = ${userId}
      UNION SELECT ${legacySessionHistory.sessionId} FROM ${legacySessionHistory}
        WHERE ${legacySessionHistory.userId} = ${userId}`,
  );
  return new Set(rows.map(([sessionId]) => sessionId));
};

const highestChunkSeq = async (db: AccountDb, userId: string): Promise<number> => {
  const rows = await db.values<[number]>(
    sql`SELECT COALESCE(MAX(${legacySessionChunks.chunkSeq}), 0) FROM ${legacySessionChunks}
      WHERE ${legacySessionChunks.userId} = ${userId}`,
  );
  return rows[0]?.[0] ?? 0;
};

// The copy, start to finish, for one account. The metadata goes first and the prose last, so a run
// that stops part way has already taken every session off the 404 it was answering with.
//
// Running it again copies nothing: every row the object holds conflicts with itself and is left
// standing, a chunk an earlier run brought over is found under the `chunk_seq` it came in with,
// and the object's own chunks are already above D1's range and so move no second time. `after` is
// where this call opens its walk of the prose, which is the frontier the call before it returned,
// and `metadataComplete` is what a call of the same run answered with before it.
export const copySessions = async (
  tenant: TenantDb,
  account: AccountDb,
  userId: string,
  after: number,
  metadataComplete: boolean,
): Promise<SessionCopyReport> => {
  const heldBefore = tenantSessionIds(tenant, userId);
  const fromD1 = await accountSessionIds(account, userId);
  // Only the call that opens the run can tell a session the object wrote itself from one an
  // earlier call of this same run copied into it.
  const straddling = after === 0 ? [...fromD1].filter((sessionId) => heldBefore.has(sessionId)).sort() : [];

  // One table of D1 into the table of the object it became. `from`'s row type has to be one the
  // insert takes, which is what holds the two schemas to each other here rather than at the run.
  //
  // The metadata is one call's work and the calls after it only count it. These tables are read
  // whole and written a row at a time, and `usage_events` is one row per event of every session
  // the account ever ran — doing that again on every call would have a long run spending its
  // budget re-conflicting rows the first call wrote, which is the stall the frontier exists to
  // remove.
  //
  // What says the phase is behind us is `metadataComplete`, which a caller only has because a call
  // of this run answered with it, and a call only answers once the phase has run to its end. A
  // count cannot stand in for it: the object holds its own post-cutover rows beside the copied
  // ones, so `usage_daily`, `counted_files` or `session_history` can outnumber D1 on the object's
  // own account and read as arrived having never been written to. Taken without the flag — a
  // resumed `--after`, a hand-run call — the phase runs again, which costs one pass and is what
  // finishes a call that died in the middle of it.
  const moved = async <A extends Owned, T extends Owned>(
    table: string,
    from: A & { $inferSelect: T["$inferInsert"] },
    into: T,
    order: ReadonlyArray<ColumnOf<A>>,
  ): Promise<TableReport> => {
    const counted = async (copied: number, held: number): Promise<TableReport> => ({
      table,
      copied,
      held,
      account: await accountCount(account, from, userId),
      tenant: tenantCount(tenant, into, userId),
    });
    if (metadataComplete) return counted(0, 0);
    const rows = await allOf(account, from, userId, order);
    const copied = copyTable(tenant, into, rows);
    return counted(copied, rows.length - copied);
  };

  const tables: TableReport[] = [
    await moved("sessions", legacySessions, sessions, [legacySessions.sessionId]),
    await moved("history", legacySessionHistory, sessionHistory, [legacySessionHistory.sessionId]),
    await moved("index", legacySessionIndex, sessionIndex, [legacySessionIndex.sessionId]),
    await moved("records", legacySessionRecords, sessionRecords, [
      legacySessionRecords.sessionId,
      legacySessionRecords.file,
    ]),
    await moved("openChunks", legacySessionOpenChunks, sessionOpenChunks, [
      legacySessionOpenChunks.sessionId,
      legacySessionOpenChunks.file,
      legacySessionOpenChunks.speaker,
    ]),
    await moved("countedFiles", legacyCountedFiles, countedFiles, [
      legacyCountedFiles.sessionId,
      legacyCountedFiles.file,
    ]),
    await moved("usageEvents", legacyUsageEvents, usageEvents, [legacyUsageEvents.sessionId, legacyUsageEvents.seq]),
    await moved("usageDaily", legacyUsageDaily, usageDaily, [
      legacyUsageDaily.day,
      legacyUsageDaily.host,
      legacyUsageDaily.repo,
      legacyUsageDaily.account,
      legacyUsageDaily.provider,
      legacyUsageDaily.model,
    ]),
    await moved("labels", legacyLabels, labels, [legacyLabels.kind, legacyLabels.value]),
    await moved("boardMessages", legacyBoardMessages, boardMessages, [legacyBoardMessages.messageId]),
    await moved("boardPickups", legacyBoardPickups, boardPickups, [legacyBoardPickups.messageId]),
  ];

  const highest = await highestChunkSeq(account, userId);
  const chunks = await copyChunks(tenant, account, userId, highest, after);
  const inD1 = await accountCount(account, legacySessionChunks, userId);
  tables.push({
    table: "chunks",
    copied: chunks.copied,
    held: chunks.held,
    account: inD1,
    tenant: tenantCount(tenant, sessionChunks, userId),
  });

  const heldAfter = tenantSessionIds(tenant, userId);
  const missing = [...fromD1].filter((sessionId) => !heldAfter.has(sessionId)).sort();
  const extra = [...heldAfter].filter((sessionId) => !fromD1.has(sessionId)).sort();
  const chunkIndex = indexIntegrity(tenant, sessionChunksFts, 1);
  const historyIndex = indexIntegrity(tenant, sessionHistoryFts, 0);
  // A table the object holds fewer rows of than D1 did not arrive, whatever its tally said. It is
  // a floor and not a proof, for the reason the prose is left out of it altogether: the object
  // holds the rows it wrote after the cutover beside the copied ones, so a table it has outgrown
  // D1 on satisfies `tenant >= account` whether or not a D1 row ever crossed. What carries the
  // metadata is the phase having run to its end, which is `metadata.complete`; what carries the
  // prose is the walk, which only the caller can add up over the run.
  const short = tables
    .filter((row) => row.table !== "chunks" && row.tenant < row.account)
    .map((row) => row.table)
    .sort();

  return {
    userId,
    tables,
    metadata: { complete: true },
    chunks: {
      copied: chunks.copied,
      held: chunks.held,
      account: inD1,
      shifted: chunks.shifted,
      moved: chunks.moved,
      frontier: chunks.frontier,
      done: chunks.done,
    },
    straddling,
    checks: {
      short,
      missing,
      extra,
      missingChunks: chunks.missing,
      embeddings: chunks.embeddings,
      chunkIndex,
      historyIndex,
      ok:
        chunks.done &&
        short.length === 0 &&
        missing.length === 0 &&
        chunks.missing === 0 &&
        chunks.embeddings.length === 0 &&
        chunkIndex.error === "" &&
        historyIndex.error === "",
    },
  };
};
