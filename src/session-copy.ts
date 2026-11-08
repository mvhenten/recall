import { and, asc, eq, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { z } from "zod";
import type {
  CopiedRowSchema,
  CopiedTableSchema,
  CopyIndexCheckSchema,
  CopySessionsSchema,
  CopyTableSchema,
  SessionCopySchema,
} from "../typespec/generated/schemas";
import type { AccountDb, TenantDb, TenantTx } from "./db";
import { rowUuid } from "./row-digest";
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

// Everything the copy answers with comes off the contract rather than being restated here, so a
// field the route adds and `typespec/main.tsp` does not know about is a type error.
export type CopiedRow = z.infer<typeof CopiedRowSchema>;
export type CopiedTable = z.infer<typeof CopiedTableSchema>;
export type CopySessionsInput = z.infer<typeof CopySessionsSchema>;
export type SessionCopyReport = z.infer<typeof SessionCopySchema>;
export type CopyIndexCheck = z.infer<typeof CopyIndexCheckSchema>;
type CopyTable = z.infer<typeof CopyTableSchema>;

// How many ids a table names when its rows did not cross, or when two of D1's own share one. The
// count beside each list is exact; the list is what an operator reads a row back out of D1 with.
const MAX_IDS = 50;

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

// One row of D1 under the id the object will be asked for it by.
interface Offered<T> {
  row: T;
  rowId: string;
}

// The rows of one table, each looked up by its id before the object is asked to take it, and each
// answered for in its own right. A row the object already holds is refused and said to be refused;
// a row that lands is said to have landed; a row that does neither — another row standing where it
// belongs — is named rather than passed over.
//
// That third answer is why the write reads before it writes. An insert that merely did nothing on
// a conflict cannot tell the three apart, and a table whose every row conflicted then reads
// exactly as a table copied twice over does: `stored: 0` either way, with nothing to say which.
//
// Written one statement at a time, never one insert of many rows, for the hundred-parameter
// ceiling on the object's SQLite, and in batches the object commits whole.
const storeRows = <T extends Owned>(
  db: TenantDb,
  table: T,
  offered: ReadonlyArray<Offered<T["$inferInsert"]>>,
  held: ReadonlySet<string>,
): CopiedRow[] => {
  const answered: CopiedRow[] = [];
  for (let start = 0; start < offered.length; start += WRITE_BATCH) {
    const batch = offered.slice(start, start + WRITE_BATCH);
    db.transaction((tx) => {
      for (const one of batch) {
        if (held.has(one.rowId)) {
          answered.push({ rowId: one.rowId, outcome: "AlreadyStored" });
          continue;
        }
        const landed = tx
          .insert(table)
          .values(one.row)
          .onConflictDoNothing()
          .returning({ owner: table.userId })
          .all().length;
        answered.push({ rowId: one.rowId, outcome: landed === 1 ? "Stored" : "Blocked" });
      }
    });
  }
  return answered;
};

// Every row of one table the object holds, under the ids the write is weighed against. It is read
// whole because an id is a reading of a row and cannot be looked up by a key — and these are the
// tables the cutover moved rather than the prose, so reading one costs what reading D1's copy of
// it already costs.
const heldIds = async (
  db: TenantDb,
  table: Owned,
  userId: string,
  only: ReadonlySet<string> | null,
): Promise<Set<string>> => {
  const rows = db.select().from(table).where(eq(table.userId, userId)).all();
  return new Set(await Promise.all(rows.map((row) => rowUuid(table, row, only))));
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
  stored: number;
  alreadyStored: number;
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
    state.stored += 1;
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
    state.alreadyStored += 1;
    return { ordinal: standing.ordinal, held: true };
  }
  if (standing !== undefined) {
    moveChunk(tx, userId, row.chunkSeq, standing.text, highest);
    state.moved += 1;
    if (landed(row.ordinal)) {
      state.stored += 1;
      return { ordinal: row.ordinal, held: false };
    }
  }
  const ordinal = nextOrdinal(tx, userId, row.sessionId, state);
  if (!landed(ordinal)) {
    throw new Error(`chunk ${row.chunkSeq} of session ${row.sessionId} found no free ordinal in the object`);
  }
  state.stored += 1;
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
    stored: 0,
    alreadyStored: 0,
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
): CopyIndexCheck => {
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
  //
  // `key` is the columns a row is known by where the whole row cannot be: a table whose
  // object-side row deliberately wins on a session both stores held has content that differs
  // there by design, and an id over the whole row would read that as a row that never crossed.
  // Given `null`, the id is over every column, which is what proves the content arrived and not
  // merely that something sits at the key.
  const moved = async <A extends Owned, T extends Owned>(
    table: CopyTable,
    from: A & { $inferSelect: T["$inferInsert"] },
    into: T,
    order: ReadonlyArray<ColumnOf<A>>,
    key: ReadonlyArray<ColumnOf<A>> | null,
  ): Promise<CopiedTable> => {
    const counted = async (answered: readonly CopiedRow[], collided: string[]): Promise<CopiedTable> => {
      const of = (outcome: string): CopiedRow[] => answered.filter((one) => one.outcome === outcome);
      const blocked = of("Blocked").map((one) => one.rowId);
      return {
        table,
        stored: of("Stored").length,
        alreadyStored: of("AlreadyStored").length,
        blocked: blocked.length,
        blockedIds: blocked.slice(0, MAX_IDS),
        collided: collided.length,
        collidedIds: collided.slice(0, MAX_IDS),
        inAccount: await accountCount(account, from, userId),
        inTenant: tenantCount(tenant, into, userId),
      };
    };
    if (metadataComplete) return counted([], []);
    const only = key === null ? null : new Set(key.map((column) => column.name));
    const rows = await allOf(account, from, userId, order);
    const offered = await Promise.all(rows.map(async (row) => ({ row, rowId: await rowUuid(from, row, only) })));
    // Two of D1's own rows under one id cannot happen: every column that identifies a row is
    // written into its id, and these tables are keyed. A repeat is the serialiser collapsing two
    // rows into one, which would hide a row that never crossed behind one that did.
    const seen = new Map<string, number>();
    for (const one of offered) seen.set(one.rowId, (seen.get(one.rowId) ?? 0) + 1);
    const collided = [...seen.entries()]
      .filter(([, times]) => times > 1)
      .map(([rowId]) => rowId)
      .sort();
    return counted(storeRows(tenant, into, offered, await heldIds(tenant, into, userId, only)), collided);
  };

  const tables: CopiedTable[] = [
    // The seven the object's own row wins on, compared by what identifies them. A session both
    // stores held keeps the object's row, and its focus, its reach, its mark and its label all
    // move on after the cutover by design.
    await moved(
      "Sessions",
      legacySessions,
      sessions,
      [legacySessions.sessionId],
      [legacySessions.userId, legacySessions.sessionId],
    ),
    await moved(
      "History",
      legacySessionHistory,
      sessionHistory,
      [legacySessionHistory.sessionId],
      [legacySessionHistory.userId, legacySessionHistory.sessionId],
    ),
    await moved(
      "Index",
      legacySessionIndex,
      sessionIndex,
      [legacySessionIndex.sessionId],
      [legacySessionIndex.userId, legacySessionIndex.sessionId],
    ),
    await moved(
      "Records",
      legacySessionRecords,
      sessionRecords,
      [legacySessionRecords.sessionId, legacySessionRecords.file],
      [legacySessionRecords.userId, legacySessionRecords.sessionId, legacySessionRecords.file],
    ),
    await moved(
      "OpenChunks",
      legacySessionOpenChunks,
      sessionOpenChunks,
      [legacySessionOpenChunks.sessionId, legacySessionOpenChunks.file, legacySessionOpenChunks.speaker],
      [
        legacySessionOpenChunks.userId,
        legacySessionOpenChunks.sessionId,
        legacySessionOpenChunks.file,
        legacySessionOpenChunks.speaker,
      ],
    ),
    await moved(
      "UsageDaily",
      legacyUsageDaily,
      usageDaily,
      [
        legacyUsageDaily.day,
        legacyUsageDaily.host,
        legacyUsageDaily.repo,
        legacyUsageDaily.account,
        legacyUsageDaily.provider,
        legacyUsageDaily.model,
      ],
      [
        legacyUsageDaily.userId,
        legacyUsageDaily.day,
        legacyUsageDaily.host,
        legacyUsageDaily.repo,
        legacyUsageDaily.account,
        legacyUsageDaily.provider,
        legacyUsageDaily.model,
      ],
    ),
    await moved(
      "Labels",
      legacyLabels,
      labels,
      [legacyLabels.kind, legacyLabels.value],
      [legacyLabels.userId, legacyLabels.kind, legacyLabels.value],
    ),
    // The four nothing rewrites. A counted file, a usage event, a board message and the pickup
    // that took it are each written once and never moved on, so the whole row is the id and a row
    // of another content standing in its place is a finding and not a design.
    await moved(
      "CountedFiles",
      legacyCountedFiles,
      countedFiles,
      [legacyCountedFiles.sessionId, legacyCountedFiles.file],
      null,
    ),
    await moved(
      "UsageEvents",
      legacyUsageEvents,
      usageEvents,
      [legacyUsageEvents.sessionId, legacyUsageEvents.seq],
      null,
    ),
    await moved("BoardMessages", legacyBoardMessages, boardMessages, [legacyBoardMessages.messageId], null),
    await moved("BoardPickups", legacyBoardPickups, boardPickups, [legacyBoardPickups.messageId], null),
  ];

  const highest = await highestChunkSeq(account, userId);
  const chunks = await copyChunks(tenant, account, userId, highest, after);
  const inD1 = await accountCount(account, legacySessionChunks, userId);
  tables.push({
    table: "Chunks",
    stored: chunks.stored,
    alreadyStored: chunks.alreadyStored,
    // The prose answers for itself a chunk at a time, by its key, its text and the instant it
    // opened on: a chunk that did not land is one `missingChunks` counts and `embeddings` would
    // have read the vector of. Nothing of it is blocked or collided.
    blocked: 0,
    blockedIds: [],
    collided: 0,
    collidedIds: [],
    inAccount: inD1,
    inTenant: tenantCount(tenant, sessionChunks, userId),
  });

  const heldAfter = tenantSessionIds(tenant, userId);
  const missing = [...fromD1].filter((sessionId) => !heldAfter.has(sessionId)).sort();
  const extra = [...heldAfter].filter((sessionId) => !fromD1.has(sessionId)).sort();
  const chunkIndex = indexIntegrity(tenant, sessionChunksFts, 1);
  const historyIndex = indexIntegrity(tenant, sessionHistoryFts, 0);
  // Two conditions, loud apart because the remedy is not the same one. A blocked row is a row of
  // D1 that did not cross and the object holds something else in its place; a collided id is the
  // serialiser writing two rows out the same way, which would hide a blocked row behind a stored
  // one and is a fault in this file rather than in the copy.
  const blocked = tables.reduce((total, row) => total + row.blocked, 0);
  const collided = tables.reduce((total, row) => total + row.collided, 0);

  return {
    userId,
    tables,
    metadataComplete: true,
    chunks: {
      stored: chunks.stored,
      alreadyStored: chunks.alreadyStored,
      inAccount: inD1,
      shifted: chunks.shifted,
      moved: chunks.moved,
      frontier: chunks.frontier,
      done: chunks.done,
    },
    straddling,
    checks: {
      missing,
      extra,
      missingChunks: chunks.missing,
      embeddings: chunks.embeddings,
      chunkIndex,
      historyIndex,
      ok:
        chunks.done &&
        blocked === 0 &&
        collided === 0 &&
        missing.length === 0 &&
        chunks.missing === 0 &&
        chunks.embeddings.length === 0 &&
        chunkIndex.error === "" &&
        historyIndex.error === "",
    },
  };
};
