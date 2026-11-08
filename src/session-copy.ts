import { and, asc, eq, sql } from "drizzle-orm";
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

export interface Tally {
  copied: number;
  held: number;
}

interface Sides {
  account: number;
  tenant: number;
}

export interface SessionCopyChecks {
  // The row count on each side, table by table. The object may hold more of any of them: a session
  // that started after the deployment cut over is the object's alone.
  rows: { sessions: Sides; history: Sides; index: Sides; chunks: Sides; records: Sides; usage: Sides };
  // Session ids D1 holds that the object does not. Anything here is a session that did not arrive.
  missing: string[];
  // Session ids the object holds that D1 does not, which a session started after the cutover
  // accounts for.
  extra: string[];
  // D1 chunks with no row in the object under the `chunk_seq` they were written with.
  missingChunks: number;
  // The chunks whose embedding does not come back out of the object as the bytes D1 holds. A
  // vector is quantized int8, so one re-encoded byte moves every score computed from it.
  embeddings: number[];
  // What SQLite makes of `session_chunks_fts` against `session_chunks`, empty when the two agree.
  // The index is external-content and the copy moves rowids by hand, so this is the one thing no
  // count can see: an entry left at a mover's old rowid answers a later query with the copied
  // chunk that now holds it.
  chunkIndex: string;
  // The same read of `session_history_fts`, which stores its own copy of the text and is written
  // by the triggers alone.
  historyIndex: string;
  ok: boolean;
}

export interface SessionCopyReport {
  userId: string;
  sessions: Tally;
  history: Tally;
  index: Tally;
  records: Tally;
  openChunks: Tally;
  countedFiles: Tally;
  usageEvents: Tally;
  usageDaily: Tally;
  labels: Tally;
  boardMessages: Tally;
  boardPickups: Tally;
  chunks: {
    copied: number;
    held: number;
    // The copied chunks that could not keep the ordinal D1 gave them, because the object already
    // indexes that ordinal of that session.
    shifted: number;
    // The object's own chunks moved up the sequence to free a `chunk_seq` a copied one came in
    // under.
    moved: number;
  };
  // The sessions both stores held before this run: the object's row is the later one and stands,
  // and what D1 holds of them that the object does not is added beside it.
  straddling: string[];
  checks: SessionCopyChecks;
}

// One page of a table nothing writes any more, taken by offset. A keyset walk would say the same
// thing against a still side and cost a composite comparison per table.
const allRows = async <T>(read: (offset: number) => Promise<T[]>): Promise<T[]> => {
  const rows: T[] = [];
  for (let offset = 0; ; offset += READ_PAGE) {
    const page = await read(offset);
    rows.push(...page);
    if (page.length < READ_PAGE) return rows;
  }
};

// The rows of one table, written one statement at a time and in batches the object commits whole.
// A row the object already holds conflicts with itself and is left exactly as it stands, which is
// what makes the object's row the one that wins and a second run cost nothing.
const writeEach = <T>(db: TenantDb, rows: readonly T[], one: (tx: TenantTx, row: T) => number): Tally => {
  let copied = 0;
  for (let start = 0; start < rows.length; start += WRITE_BATCH) {
    const batch = rows.slice(start, start + WRITE_BATCH);
    db.transaction((tx) => {
      for (const row of batch) copied += one(tx, row);
    });
  }
  return { copied, held: rows.length - copied };
};

const accountSessions = (db: AccountDb, userId: string): Promise<Array<typeof legacySessions.$inferSelect>> =>
  allRows((offset) =>
    db
      .select()
      .from(legacySessions)
      .where(eq(legacySessions.userId, userId))
      .orderBy(asc(legacySessions.sessionId))
      .limit(READ_PAGE)
      .offset(offset)
      .all(),
  );

const accountHistory = (db: AccountDb, userId: string): Promise<Array<typeof legacySessionHistory.$inferSelect>> =>
  allRows((offset) =>
    db
      .select()
      .from(legacySessionHistory)
      .where(eq(legacySessionHistory.userId, userId))
      .orderBy(asc(legacySessionHistory.sessionId))
      .limit(READ_PAGE)
      .offset(offset)
      .all(),
  );

const accountIndex = (db: AccountDb, userId: string): Promise<Array<typeof legacySessionIndex.$inferSelect>> =>
  allRows((offset) =>
    db
      .select()
      .from(legacySessionIndex)
      .where(eq(legacySessionIndex.userId, userId))
      .orderBy(asc(legacySessionIndex.sessionId))
      .limit(READ_PAGE)
      .offset(offset)
      .all(),
  );

const accountRecords = (db: AccountDb, userId: string): Promise<Array<typeof legacySessionRecords.$inferSelect>> =>
  allRows((offset) =>
    db
      .select()
      .from(legacySessionRecords)
      .where(eq(legacySessionRecords.userId, userId))
      .orderBy(asc(legacySessionRecords.sessionId), asc(legacySessionRecords.file))
      .limit(READ_PAGE)
      .offset(offset)
      .all(),
  );

const accountOpenChunks = (
  db: AccountDb,
  userId: string,
): Promise<Array<typeof legacySessionOpenChunks.$inferSelect>> =>
  allRows((offset) =>
    db
      .select()
      .from(legacySessionOpenChunks)
      .where(eq(legacySessionOpenChunks.userId, userId))
      .orderBy(
        asc(legacySessionOpenChunks.sessionId),
        asc(legacySessionOpenChunks.file),
        asc(legacySessionOpenChunks.speaker),
      )
      .limit(READ_PAGE)
      .offset(offset)
      .all(),
  );

const accountCountedFiles = (db: AccountDb, userId: string): Promise<Array<typeof legacyCountedFiles.$inferSelect>> =>
  allRows((offset) =>
    db
      .select()
      .from(legacyCountedFiles)
      .where(eq(legacyCountedFiles.userId, userId))
      .orderBy(asc(legacyCountedFiles.sessionId), asc(legacyCountedFiles.file))
      .limit(READ_PAGE)
      .offset(offset)
      .all(),
  );

const accountUsageEvents = (db: AccountDb, userId: string): Promise<Array<typeof legacyUsageEvents.$inferSelect>> =>
  allRows((offset) =>
    db
      .select()
      .from(legacyUsageEvents)
      .where(eq(legacyUsageEvents.userId, userId))
      .orderBy(asc(legacyUsageEvents.sessionId), asc(legacyUsageEvents.seq))
      .limit(READ_PAGE)
      .offset(offset)
      .all(),
  );

const accountUsageDaily = (db: AccountDb, userId: string): Promise<Array<typeof legacyUsageDaily.$inferSelect>> =>
  allRows((offset) =>
    db
      .select()
      .from(legacyUsageDaily)
      .where(eq(legacyUsageDaily.userId, userId))
      .orderBy(
        asc(legacyUsageDaily.day),
        asc(legacyUsageDaily.host),
        asc(legacyUsageDaily.repo),
        asc(legacyUsageDaily.account),
        asc(legacyUsageDaily.provider),
        asc(legacyUsageDaily.model),
      )
      .limit(READ_PAGE)
      .offset(offset)
      .all(),
  );

const accountLabels = (db: AccountDb, userId: string): Promise<Array<typeof legacyLabels.$inferSelect>> =>
  allRows((offset) =>
    db
      .select()
      .from(legacyLabels)
      .where(eq(legacyLabels.userId, userId))
      .orderBy(asc(legacyLabels.kind), asc(legacyLabels.value))
      .limit(READ_PAGE)
      .offset(offset)
      .all(),
  );

const accountBoardMessages = (db: AccountDb, userId: string): Promise<Array<typeof legacyBoardMessages.$inferSelect>> =>
  allRows((offset) =>
    db
      .select()
      .from(legacyBoardMessages)
      .where(eq(legacyBoardMessages.userId, userId))
      .orderBy(asc(legacyBoardMessages.messageId))
      .limit(READ_PAGE)
      .offset(offset)
      .all(),
  );

const accountBoardPickups = (db: AccountDb, userId: string): Promise<Array<typeof legacyBoardPickups.$inferSelect>> =>
  allRows((offset) =>
    db
      .select()
      .from(legacyBoardPickups)
      .where(eq(legacyBoardPickups.userId, userId))
      .orderBy(asc(legacyBoardPickups.messageId))
      .limit(READ_PAGE)
      .offset(offset)
      .all(),
  );

interface LegacyChunk {
  chunkSeq: number;
  sessionId: string;
  ordinal: number;
  speaker: "user" | "model";
  text: string;
  embedding: Uint8Array;
  at: number;
}

type ChunkRow = [number, string, number, string, string, unknown, number];

const speakerOf = (value: string): "user" | "model" => {
  if (value === "user" || value === "model") return value;
  throw new Error(`D1 holds a chunk spoken by neither the user nor the model: ${value}`);
};

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
    speaker: speakerOf(row[3]),
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
  // The `chunk_seq` the next moved row takes, above every key either store has handed out.
  next: number;
  // The ordinal the next shifted chunk of a session takes.
  ordinals: Map<string, number>;
}

// The object's own chunk, moved off a `chunk_seq` a copied one came in under. `chunk_seq` is
// `session_chunks_fts`'s `content_rowid` and nothing fires on an update of it — the triggers are
// an insert and a delete — so the index entry is moved here by hand. Left behind, it would answer
// a later query with the rowid that by then names a copied chunk.
//
// Moving up rather than renumbering the copy is also what keeps `chunk_seq` meaning recency: the
// vector scan bounds itself to the highest keys, and a chunk the object wrote after the cutover is
// the newest prose the account has.
const moveChunk = (tx: TenantTx, userId: string, from: number, text: string, to: number): void => {
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
// Three things can stand in the way of it, and the row already at that key says which. A row with
// the same session and the same prose is this chunk, copied by an earlier run, and is left alone.
// A row of another session is the object's own and moves up. What is left is an ordinal of this
// session the object already indexes, which the chunk climbs past.
const placeChunk = (tx: TenantTx, userId: string, row: LegacyChunk, state: ChunkState): number => {
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
    return row.ordinal;
  }
  const standing = tx
    .select({ sessionId: sessionChunks.sessionId, ordinal: sessionChunks.ordinal, text: sessionChunks.text })
    .from(sessionChunks)
    .where(and(eq(sessionChunks.userId, userId), eq(sessionChunks.chunkSeq, row.chunkSeq)))
    .get();
  if (standing !== undefined && standing.sessionId === row.sessionId && standing.text === row.text) {
    state.held += 1;
    return standing.ordinal;
  }
  if (standing !== undefined) {
    moveChunk(tx, userId, row.chunkSeq, standing.text, state.next);
    state.next += 1;
    state.moved += 1;
    if (landed(row.ordinal)) {
      state.copied += 1;
      return row.ordinal;
    }
  }
  const ordinal = nextOrdinal(tx, userId, row.sessionId, state);
  if (!landed(ordinal)) {
    throw new Error(`chunk ${row.chunkSeq} of session ${row.sessionId} found no free ordinal in the object`);
  }
  state.copied += 1;
  state.shifted += 1;
  return ordinal;
};

// How far a session's chunks now reach, which is the ordinal the next pass of either indexing path
// takes. A shifted chunk that left this behind would be written over by the next stretch the
// session archives.
const raiseReach = (db: TenantDb, userId: string, reach: ReadonlyMap<string, number>): void => {
  db.transaction((tx) => {
    for (const [sessionId, chunks] of reach) {
      tx.insert(sessionIndex)
        .values({ userId, sessionId, archived: 0, bytes: 0, chunks })
        .onConflictDoUpdate({
          target: [sessionIndex.userId, sessionIndex.sessionId],
          set: { chunks: sql`MAX(session_index.chunks, excluded.chunks)` },
        })
        .run();
    }
  });
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

// The page read back out of the object and held against the page that went in. It runs beside the
// copy rather than after it so that the vectors are compared while they are still in hand: a
// second pass over the whole corpus to check them would read every chunk out of D1 twice.
const verifyChunkPage = (db: TenantDb, userId: string, page: readonly LegacyChunk[], state: ChunkState): void => {
  const seqs = JSON.stringify(page.map((row) => row.chunkSeq));
  const stored = new Map(
    db
      .values<[number, unknown]>(
        sql`SELECT ${sessionChunks.chunkSeq}, ${sessionChunks.embedding} FROM ${sessionChunks}
          WHERE ${sessionChunks.userId} = ${userId}
            AND ${sessionChunks.chunkSeq} IN (SELECT value FROM json_each(${seqs}))`,
      )
      .map(([chunkSeq, embedding]): [number, Uint8Array] => [chunkSeq, toBytes(embedding)]),
  );
  for (const row of page) {
    const got = stored.get(row.chunkSeq);
    if (got === undefined) {
      state.missing += 1;
      continue;
    }
    if (!sameBytes(got, row.embedding)) state.embeddings.push(row.chunkSeq);
  }
};

// The account's prose, a page at a time, so that neither the vectors nor the text of a corpus that
// runs to hundreds of megabytes is ever held whole. Each page is one batch: a run that stops part
// way leaves every page before it committed, and the next run walks from the start and passes over
// them a chunk at a time.
const copyChunks = async (
  tenant: TenantDb,
  account: AccountDb,
  userId: string,
  highest: number,
): Promise<ChunkState> => {
  const top = tenant
    .select({ top: sql<number>`COALESCE(MAX(${sessionChunks.chunkSeq}), 0)` })
    .from(sessionChunks)
    .where(eq(sessionChunks.userId, userId))
    .get();
  const state: ChunkState = {
    copied: 0,
    held: 0,
    shifted: 0,
    moved: 0,
    missing: 0,
    embeddings: [],
    next: Math.max(highest, top?.top ?? 0) + 1,
    ordinals: new Map(),
  };
  let after = 0;
  for (;;) {
    const page = await accountChunkPage(account, userId, after);
    if (page.length === 0) return state;
    const reach = new Map<string, number>();
    tenant.transaction((tx) => {
      for (const row of page) {
        const ordinal = placeChunk(tx, userId, row, state);
        reach.set(row.sessionId, Math.max(reach.get(row.sessionId) ?? 0, ordinal + 1));
      }
    });
    raiseReach(tenant, userId, reach);
    verifyChunkPage(tenant, userId, page, state);
    const last = page.at(-1);
    if (last === undefined || page.length < CHUNK_PAGE) return state;
    after = last.chunkSeq;
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
// ending the run as a failed request that says nothing about any of them.
const indexIntegrity = (
  db: TenantDb,
  table: typeof sessionChunksFts | typeof sessionHistoryFts,
  rank: 0 | 1,
): string => {
  try {
    db.run(
      rank === 1
        ? sql`INSERT INTO ${table} (${table}, rank) VALUES ('integrity-check', 1)`
        : sql`INSERT INTO ${table} (${table}) VALUES ('integrity-check')`,
    );
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const tenantCount = (db: TenantDb, query: ReturnType<typeof sql>): number => db.values<[number]>(query)[0]?.[0] ?? 0;

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

interface Counted {
  sessions: number;
  history: number;
  index: number;
  chunks: number;
  records: number;
  usage: number;
}

const accountCounts = async (db: AccountDb, userId: string): Promise<Counted> => {
  const one = async (query: ReturnType<typeof sql>): Promise<number> => {
    const rows = await db.values<[number]>(query);
    return rows[0]?.[0] ?? 0;
  };
  return {
    sessions: await one(sql`SELECT count(*) FROM ${legacySessions} WHERE ${legacySessions.userId} = ${userId}`),
    history: await one(
      sql`SELECT count(*) FROM ${legacySessionHistory} WHERE ${legacySessionHistory.userId} = ${userId}`,
    ),
    index: await one(sql`SELECT count(*) FROM ${legacySessionIndex} WHERE ${legacySessionIndex.userId} = ${userId}`),
    chunks: await one(sql`SELECT count(*) FROM ${legacySessionChunks} WHERE ${legacySessionChunks.userId} = ${userId}`),
    records: await one(
      sql`SELECT count(*) FROM ${legacySessionRecords} WHERE ${legacySessionRecords.userId} = ${userId}`,
    ),
    usage: await one(sql`SELECT count(*) FROM ${legacyUsageEvents} WHERE ${legacyUsageEvents.userId} = ${userId}`),
  };
};

const tenantCounts = (db: TenantDb, userId: string): Counted => ({
  sessions: tenantCount(db, sql`SELECT count(*) FROM ${sessions} WHERE ${sessions.userId} = ${userId}`),
  history: tenantCount(db, sql`SELECT count(*) FROM ${sessionHistory} WHERE ${sessionHistory.userId} = ${userId}`),
  index: tenantCount(db, sql`SELECT count(*) FROM ${sessionIndex} WHERE ${sessionIndex.userId} = ${userId}`),
  chunks: tenantCount(db, sql`SELECT count(*) FROM ${sessionChunks} WHERE ${sessionChunks.userId} = ${userId}`),
  records: tenantCount(db, sql`SELECT count(*) FROM ${sessionRecords} WHERE ${sessionRecords.userId} = ${userId}`),
  usage: tenantCount(db, sql`SELECT count(*) FROM ${usageEvents} WHERE ${usageEvents.userId} = ${userId}`),
});

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
// and the object's own chunks are already above D1's range and so move no second time.
export const copySessions = async (
  tenant: TenantDb,
  account: AccountDb,
  userId: string,
): Promise<SessionCopyReport> => {
  const heldBefore = tenantSessionIds(tenant, userId);
  const live = await accountSessions(account, userId);
  const past = await accountHistory(account, userId);
  const fromD1 = new Set([...live, ...past].map((row) => row.sessionId));
  const straddling = [...fromD1].filter((sessionId) => heldBefore.has(sessionId)).sort();

  const copied = {
    sessions: writeEach(
      tenant,
      live,
      (tx, row) =>
        tx.insert(sessions).values(row).onConflictDoNothing().returning({ id: sessions.sessionId }).all().length,
    ),
    history: writeEach(
      tenant,
      past,
      (tx, row) =>
        tx.insert(sessionHistory).values(row).onConflictDoNothing().returning({ id: sessionHistory.sessionId }).all()
          .length,
    ),
    index: writeEach(
      tenant,
      await accountIndex(account, userId),
      (tx, row) =>
        tx.insert(sessionIndex).values(row).onConflictDoNothing().returning({ id: sessionIndex.sessionId }).all()
          .length,
    ),
    records: writeEach(
      tenant,
      await accountRecords(account, userId),
      (tx, row) =>
        tx.insert(sessionRecords).values(row).onConflictDoNothing().returning({ file: sessionRecords.file }).all()
          .length,
    ),
    openChunks: writeEach(
      tenant,
      await accountOpenChunks(account, userId),
      (tx, row) =>
        tx.insert(sessionOpenChunks).values(row).onConflictDoNothing().returning({ file: sessionOpenChunks.file }).all()
          .length,
    ),
    countedFiles: writeEach(
      tenant,
      await accountCountedFiles(account, userId),
      (tx, row) =>
        tx.insert(countedFiles).values(row).onConflictDoNothing().returning({ file: countedFiles.file }).all().length,
    ),
    usageEvents: writeEach(
      tenant,
      await accountUsageEvents(account, userId),
      (tx, row) =>
        tx.insert(usageEvents).values(row).onConflictDoNothing().returning({ seq: usageEvents.seq }).all().length,
    ),
    usageDaily: writeEach(
      tenant,
      await accountUsageDaily(account, userId),
      (tx, row) =>
        tx.insert(usageDaily).values(row).onConflictDoNothing().returning({ day: usageDaily.day }).all().length,
    ),
    labels: writeEach(
      tenant,
      await accountLabels(account, userId),
      (tx, row) => tx.insert(labels).values(row).onConflictDoNothing().returning({ value: labels.value }).all().length,
    ),
    boardMessages: writeEach(
      tenant,
      await accountBoardMessages(account, userId),
      (tx, row) =>
        tx.insert(boardMessages).values(row).onConflictDoNothing().returning({ id: boardMessages.messageId }).all()
          .length,
    ),
    boardPickups: writeEach(
      tenant,
      await accountBoardPickups(account, userId),
      (tx, row) =>
        tx.insert(boardPickups).values(row).onConflictDoNothing().returning({ id: boardPickups.messageId }).all()
          .length,
    ),
  };

  const chunks = await copyChunks(tenant, account, userId, await highestChunkSeq(account, userId));
  const heldAfter = tenantSessionIds(tenant, userId);
  const missing = [...fromD1].filter((sessionId) => !heldAfter.has(sessionId)).sort();
  const extra = [...heldAfter].filter((sessionId) => !fromD1.has(sessionId)).sort();
  const chunkIndex = indexIntegrity(tenant, sessionChunksFts, 1);
  const historyIndex = indexIntegrity(tenant, sessionHistoryFts, 0);
  const counts = { account: await accountCounts(account, userId), tenant: tenantCounts(tenant, userId) };
  const sidesOf = (key: keyof Counted): Sides => ({ account: counts.account[key], tenant: counts.tenant[key] });
  return {
    userId,
    ...copied,
    chunks: { copied: chunks.copied, held: chunks.held, shifted: chunks.shifted, moved: chunks.moved },
    straddling,
    checks: {
      rows: {
        sessions: sidesOf("sessions"),
        history: sidesOf("history"),
        index: sidesOf("index"),
        chunks: sidesOf("chunks"),
        records: sidesOf("records"),
        usage: sidesOf("usage"),
      },
      missing,
      extra,
      missingChunks: chunks.missing,
      embeddings: chunks.embeddings,
      chunkIndex,
      historyIndex,
      ok:
        missing.length === 0 &&
        chunks.missing === 0 &&
        chunks.embeddings.length === 0 &&
        chunkIndex === "" &&
        historyIndex === "",
    },
  };
};
