import { and, asc, count, desc, eq, getTableName, gt, gte, inArray, lt, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { type SQLiteColumn, type SQLiteTable, union, unionAll } from "drizzle-orm/sqlite-core";
import type { ArtifactCopyReport } from "./artifact-copy";
import {
  type ArtifactFile,
  type ArtifactListInput,
  type ArtifactRecord,
  type ArtifactType,
  artifactTypes,
  contentTypeFor,
  type ReadPermission,
  type WritePermission,
} from "./artifacts";
import {
  BOARD_WINDOW_MS,
  type BoardEntry,
  type BoardInput,
  type BoardMessage,
  type BoardScope,
  type BoardTaker,
  MAX_PICKUP_BYTES,
} from "./board";
import type { OpenChunk } from "./chunks";
import type { AccountDb, TenantDb, TenantTx } from "./db";
import type { Caller } from "./device";
import {
  DAY_MS,
  type DayWindow,
  type HistoryFilters,
  type HistoryInput,
  IDLE_AFTER_MS,
  type Insights,
  type Label,
  type LabelKind,
  type Labels,
  type LabelTargets,
  type ListInput,
  type Live,
  type Memory,
  type MemoryCounts,
  type MemoryType,
  type ModelTotals,
  NEVER_RECALLED_AFTER_DAYS,
  type PastSession,
  type SaveInput,
  SESSION_TTL_MS,
  type Session,
  type SessionInput,
  type SessionSpend,
  STALE_AFTER_DAYS,
  type Stats,
  type StatsWindows,
  sessionHandle,
  type TokenCounts,
  USAGE_MONTH_DAYS,
  USAGE_RETENTION_MS,
  type UsageInput,
  type UsageSplitField,
  usageDay,
  usageDayStart,
} from "./model";
import { artifactNames, artifactShares, mcpClients } from "./schema/account";
import { blobOf, toBytes } from "./schema/columns";
import { artifactsFts, memoriesFts, sessionChunksFts, sessionHistoryFts } from "./schema/fts";
import {
  artifactRevisions,
  artifacts,
  boardMessages,
  boardPickups,
  countedFiles as countedFilesTable,
  labels as labelsTable,
  memories,
  memoryTags,
  sessionChunks,
  sessionHistory,
  sessionIndex,
  sessionOpenChunks,
  sessionRecords,
  sessions,
  usageDaily,
  usageEvents,
} from "./schema/tenant";
import type { ShareMode, ShareRecord } from "./shares";
import { MAIN_FILE } from "./transcripts";
import type { Speaker } from "./turns";

// A list of values goes in as one JSON parameter and is unpacked by `json_each`, because SQLite
// binds at most a hundred parameters to a statement and both stores hold it to that.
export const jsonEach = (values: readonly unknown[]): SQL =>
  sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

// A column written with the table it belongs to. Drizzle drops the table from a column it puts in
// the select list of a single-table query, and an unqualified name inside a correlated subquery
// binds to the inner table instead of the outer one — which reads every row rather than the one.
const qualified = (column: SQLiteColumn): SQL =>
  sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;

interface MemoryRow {
  memoryId: string;
  userId: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  createdAt: number;
  updatedAt: number;
  recallCount: number;
  lastRecalledAt: number;
  tags: string;
}

// A page of a listing is one read however many tags the memories on it hold.
const MEMORY_FIELDS = {
  memoryId: memories.memoryId,
  userId: memories.userId,
  name: memories.name,
  description: memories.description,
  type: memories.type,
  body: memories.body,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
  recallCount: memories.recallCount,
  lastRecalledAt: memories.lastRecalledAt,
  tags: sql<string>`(SELECT json_group_array(tag) FROM
    (SELECT ${qualified(memoryTags.tag)} FROM ${memoryTags}
     WHERE ${qualified(memoryTags.memoryId)} = ${qualified(memories.memoryId)}
     ORDER BY ${qualified(memoryTags.tag)}))`,
};

const tagFilter = (tags: readonly string[]): SQL =>
  sql`(json_array_length(${JSON.stringify(tags)}) = 0 OR EXISTS (
    SELECT 1 FROM ${memoryTags}
    WHERE ${qualified(memoryTags.memoryId)} = ${qualified(memories.memoryId)}
      AND ${qualified(memoryTags.tag)} IN ${jsonEach(tags)}))`;

const typeFilter = (types: readonly MemoryType[]): SQL =>
  sql`(json_array_length(${JSON.stringify(types)}) = 0 OR ${qualified(memories.type)} IN ${jsonEach(types)})`;

const toMemory = (row: MemoryRow): Memory => ({
  memoryId: row.memoryId,
  userId: row.userId,
  name: row.name,
  description: row.description,
  type: row.type,
  body: row.body,
  tags: JSON.parse(row.tags),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  recallCount: row.recallCount,
  lastRecalledAt: row.lastRecalledAt,
});

export const getMemory = async (db: TenantDb, userId: string, name: string): Promise<Memory | null> => {
  const row = db
    .select(MEMORY_FIELDS)
    .from(memories)
    .where(and(eq(memories.userId, userId), eq(memories.name, name)))
    .get();
  return row === undefined ? null : toMemory(row);
};

export const saveMemory = async (
  db: TenantDb,
  userId: string,
  name: string,
  input: SaveInput,
  embedding: Uint8Array,
  now: number,
): Promise<{ memory: Memory; created: boolean }> => {
  const candidateId = crypto.randomUUID();
  const ownedId = sql`(SELECT ${memories.memoryId} FROM ${memories}
    WHERE ${memories.userId} = ${userId} AND ${memories.name} = ${name})`;
  const created = db.transaction((tx) => {
    const [upsert] = tx
      .insert(memories)
      .values({
        memoryId: candidateId,
        userId,
        name,
        description: input.description,
        type: input.type,
        body: input.body,
        embedding,
        createdAt: now,
        updatedAt: now,
        recallCount: 0,
        lastRecalledAt: 0,
      })
      .onConflictDoUpdate({
        target: [memories.userId, memories.name],
        set: {
          description: sql`excluded.description`,
          type: sql`excluded.type`,
          body: sql`excluded.body`,
          embedding: sql`excluded.embedding`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ memoryId: memories.memoryId })
      .all();
    tx.delete(memoryTags).where(eq(memoryTags.memoryId, ownedId)).run();
    tx.insert(memoryTags)
      .select(sql`SELECT ${ownedId}, value FROM json_each(${JSON.stringify(input.tags)})`)
      .run();
    return upsert?.memoryId === candidateId;
  });
  const memory = await getMemory(db, userId, name);
  if (!memory) throw new Error(`memory ${name} vanished right after it was saved`);
  return { memory, created };
};

export const deleteMemory = async (db: TenantDb, userId: string, memoryId: string): Promise<void> => {
  db.delete(memories)
    .where(and(eq(memories.userId, userId), eq(memories.memoryId, memoryId)))
    .run();
};

// Where a page of a list stops: the value the order is keyed on, and the row id that breaks a tie
// on it. The value is a string where the order is a name, which is why it is not a number alone.
export type Cursor = [number | string, string];

const encodeCursor = (at: number | string, id: string): string => btoa(JSON.stringify([at, id]));

const readCursorJson = (cursor: string): unknown => {
  try {
    return JSON.parse(atob(cursor));
  } catch {
    return null;
  }
};

// Page one: for a descending order a value no row can be above, for an ascending one a value no
// row can be below.
export const startCursor = (direction: "desc" | "asc"): Cursor =>
  direction === "desc" ? [Number.MAX_SAFE_INTEGER, ""] : ["", ""];

// The empty cursor is page one. The two-element shape is the one the dashboard has always issued,
// so a bookmarked page link from before this still decodes and pages.
export const decodeCursor = (cursor: string, direction: "desc" | "asc"): Cursor | null => {
  if (cursor === "") return startCursor(direction);
  const parsed = readCursorJson(cursor);
  if (!Array.isArray(parsed) || typeof parsed[1] !== "string") return null;
  const at = parsed[0];
  if (typeof at !== "number" && typeof at !== "string") return null;
  return [at, parsed[1]];
};

// Nothing is ordered in the Worker, so a list grows an order by growing this table and nothing
// else. The keyset is written out rather than built from comparisons because a cursor is a number
// on one order and a name on the next, and SQLite compares the bound value against the column
// either way.
interface Order<Row> {
  keyset: (at: number | string, id: string) => SQL;
  by: SQL[];
  direction: "desc" | "asc";
  cursorOf: (row: Row) => Cursor;
}

const orderFor = <Row>(orders: Record<string, Order<Row>>, sort: string): Order<Row> => {
  const order = orders[sort];
  if (order === undefined) throw new Error(`no order named ${sort}`);
  return order;
};

// memories_by_user_created, memories (user_id, name) and memories_by_recall_count in that order.
const MEMORY_ORDERS: Record<string, Order<Memory>> = {
  newest: {
    keyset: (at, id) =>
      sql`(${memories.createdAt} < ${at} OR (${memories.createdAt} = ${at} AND ${memories.memoryId} < ${id}))`,
    by: [desc(memories.createdAt), desc(memories.memoryId)],
    direction: "desc",
    cursorOf: (memory) => [memory.createdAt, memory.memoryId],
  },
  name: {
    keyset: (at) => sql`${memories.name} > ${at}`,
    by: [asc(memories.name)],
    direction: "asc",
    cursorOf: (memory) => [memory.name, memory.name],
  },
  recalled: {
    keyset: (at, id) =>
      sql`(${memories.recallCount} < ${at} OR (${memories.recallCount} = ${at} AND ${memories.name} > ${id}))`,
    by: [desc(memories.recallCount), asc(memories.name)],
    direction: "desc",
    cursorOf: (memory) => [memory.recallCount, memory.name],
  },
};

export const memoryCursorDirection = (sort: string): "desc" | "asc" => orderFor(MEMORY_ORDERS, sort).direction;

export const listMemories = async (
  db: TenantDb,
  userId: string,
  input: ListInput,
  [cursorAt, cursorId]: Cursor,
): Promise<{ memories: Memory[]; nextCursor: string }> => {
  const order = orderFor(MEMORY_ORDERS, input.sort);
  const results = db
    .select(MEMORY_FIELDS)
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        tagFilter(input.tags),
        typeFilter(input.types),
        gte(memories.createdAt, input.since),
        order.keyset(cursorAt, cursorId),
      ),
    )
    .orderBy(...order.by)
    .limit(input.limit + 1)
    .all();
  const found = results.slice(0, input.limit).map(toMemory);
  const last = found.at(-1);
  const nextCursor = results.length > input.limit && last ? encodeCursor(...order.cursorOf(last)) : "";
  return { memories: found, nextCursor };
};

export const memoryCounts = async (db: TenantDb, userId: string, since: number): Promise<MemoryCounts> => {
  const results = db
    .select({
      type: memories.type,
      total: count(),
      recalled: sql<number>`SUM(CASE WHEN ${memories.recallCount} > 0 THEN 1 ELSE 0 END)`,
      fresh: sql<number>`SUM(CASE WHEN ${memories.createdAt} >= ${since} THEN 1 ELSE 0 END)`,
    })
    .from(memories)
    .where(eq(memories.userId, userId))
    .groupBy(memories.type)
    .orderBy(desc(count()), asc(memories.type))
    .all();
  const sum = (pick: (row: { total: number; recalled: number; fresh: number }) => number): number =>
    results.reduce((running, row) => running + pick(row), 0);
  return {
    total: sum((row) => row.total),
    recalled: sum((row) => row.recalled),
    fresh: sum((row) => row.fresh),
    byType: results.map((row) => ({ type: row.type, count: row.total })),
  };
};

export interface VectorCandidate {
  memoryId: string;
  embedding: Uint8Array;
  inScope: boolean;
}

export interface TextCandidate {
  memoryId: string;
  inScope: boolean;
}

// Read as positional rows rather than objects: this is every vector the account holds, and naming a
// column per row costs more than the scoring does.
export const vectorCandidates = async (
  db: TenantDb,
  userId: string,
  tags: string[],
  types: MemoryType[],
): Promise<VectorCandidate[]> => {
  const rows = db.values<[string, unknown, number]>(sql`
    SELECT ${memories.memoryId}, ${memories.embedding}, ${tagFilter(tags)} FROM ${memories}
    WHERE ${memories.userId} = ${userId} AND ${typeFilter(types)}`);
  return rows.map(([memoryId, embedding, inScope]) => ({
    memoryId,
    embedding: toBytes(embedding),
    inScope: inScope === 1,
  }));
};

// How deep a text match a search reads. The limit is the caller's because it bounds the rows the
// statement returns, not the rows the caller keeps: a caller that drops some of them afterwards
// has to ask for them on top.
export const TEXT_CANDIDATES = 50;

export const textCandidates = async (
  db: TenantDb,
  userId: string,
  tags: string[],
  types: MemoryType[],
  query: string,
  limit: number,
): Promise<TextCandidate[]> => {
  const results = db
    .select({ memoryId: memories.memoryId, inScope: tagFilter(tags).mapWith(Number).as("in_scope") })
    .from(memoriesFts)
    .innerJoin(memories, eq(memories.memorySeq, memoriesFts.rowid))
    .where(and(sql`${memoriesFts} MATCH ${query}`, eq(memories.userId, userId), typeFilter(types)))
    .orderBy(sql`in_scope DESC, bm25(${memoriesFts}, 5.0, 2.0, 1.0)`)
    .limit(limit)
    .all();
  return results.map((row) => ({ memoryId: row.memoryId, inScope: row.inScope === 1 }));
};

export const describeMemories = async (db: TenantDb, userId: string, memoryIds: string[]): Promise<Memory[]> => {
  const results = db
    .select(MEMORY_FIELDS)
    .from(memories)
    .where(and(eq(memories.userId, userId), sql`${memories.memoryId} IN ${jsonEach(memoryIds)}`))
    .all();
  return results.map(toMemory);
};

const SESSION_FIELDS = {
  sessionId: sessions.sessionId,
  deviceName: sessions.deviceName,
  agentName: sessions.agentName,
  deviceId: sessions.deviceId,
  host: sessions.host,
  cwd: sessions.cwd,
  repo: sessions.repo,
  branch: sessions.branch,
  commitSubject: sessions.commitSubject,
  startedAt: sessions.startedAt,
  lastActivityAt: sessions.lastActivityAt,
  prompts: sessions.prompts,
  focusFirst: sessions.focusFirst,
  focusLatest: sessions.focusLatest,
  mode: sessions.mode,
  permissionMode: sessions.permissionMode,
  pid: sessions.pid,
};

type SessionRow = { [Field in keyof typeof SESSION_FIELDS]: (typeof SESSION_FIELDS)[Field]["_"]["data"] };

const toSession = (row: SessionRow): Session => ({
  sessionId: row.sessionId,
  name: sessionHandle(row.deviceName, row.sessionId),
  agentName: row.agentName,
  deviceId: row.deviceId,
  host: row.host,
  cwd: row.cwd,
  repo: row.repo,
  branch: row.branch,
  commit: row.commitSubject,
  startedAt: row.startedAt,
  lastActivityAt: row.lastActivityAt,
  prompts: row.prompts,
  focus: { first: row.focusFirst, latest: row.focusLatest },
  mode: row.mode,
  permissionMode: row.permissionMode,
  pid: row.pid,
});

const expireSessions = (db: TenantTx, userId: string, now: number): void => {
  db.delete(sessions)
    .where(and(eq(sessions.userId, userId), lte(sessions.lastActivityAt, now - SESSION_TTL_MS)))
    .run();
};

export const putSession = async (
  db: TenantDb,
  caller: Caller,
  sessionId: string,
  input: SessionInput,
  now: number,
): Promise<void> => {
  db.transaction((tx) => {
    expireSessions(tx, caller.userId, now);
    tx.insert(sessions)
      .values({
        userId: caller.userId,
        sessionId,
        deviceId: caller.deviceId,
        deviceName: caller.name,
        host: input.host,
        cwd: input.cwd,
        repo: input.repo,
        branch: input.branch,
        commitSubject: input.commit,
        startedAt: input.startedAt,
        lastActivityAt: input.lastActivityAt,
        prompts: input.prompts,
        focusFirst: input.focus.first,
        focusLatest: input.focus.latest,
        mode: input.mode,
        permissionMode: input.permissionMode,
        pid: input.pid,
      })
      .onConflictDoUpdate({
        target: [sessions.userId, sessions.sessionId],
        set: {
          deviceId: sql`excluded.device_id`,
          deviceName: sql`excluded.device_name`,
          host: sql`excluded.host`,
          cwd: sql`excluded.cwd`,
          repo: sql`excluded.repo`,
          branch: sql`excluded.branch`,
          commitSubject: sql`excluded.commit_subject`,
          startedAt: sql`excluded.started_at`,
          lastActivityAt: sql`excluded.last_activity_at`,
          prompts: sql`excluded.prompts`,
          focusFirst: sql`excluded.focus_first`,
          focusLatest: sql`excluded.focus_latest`,
          mode: sql`excluded.mode`,
          permissionMode: sql`excluded.permission_mode`,
          pid: sql`excluded.pid`,
        },
      })
      .run();
    // The history row is copied out of the session the statement above just wrote, so the two can
    // never disagree, and `INSERT OR REPLACE` is what keeps one row per session however often it
    // syncs. Neither is a shape drizzle's insert builder can take.
    tx.run(sql`INSERT OR REPLACE INTO ${sessionHistory} (user_id, session_id, device_id, device_name, host, cwd,
        repo, branch, commit_subject, started_at, last_activity_at, prompts, focus_first, focus_latest, mode,
        agent_name)
      SELECT ${sessions.userId}, ${sessions.sessionId}, ${sessions.deviceId}, ${sessions.deviceName},
        ${sessions.host}, ${sessions.cwd}, ${sessions.repo}, ${sessions.branch}, ${sessions.commitSubject},
        ${sessions.startedAt}, ${sessions.lastActivityAt}, ${sessions.prompts}, ${sessions.focusFirst},
        ${sessions.focusLatest}, ${sessions.mode}, ${sessions.agentName}
      FROM ${sessions}
      WHERE ${sessions.userId} = ${caller.userId} AND ${sessions.sessionId} = ${sessionId}`);
  });
};

// RETURNING is what counts the rows a delete reached, which a Durable Object's SQLite does not
// otherwise report through drizzle.
export const endSession = async (db: TenantDb, userId: string, sessionId: string): Promise<boolean> => {
  const ended = db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.sessionId, sessionId)))
    .returning({ sessionId: sessions.sessionId })
    .all();
  return ended.length === 1;
};

export const listSessions = async (db: TenantDb, userId: string, now: number): Promise<Session[]> =>
  db
    .transaction((tx) => {
      expireSessions(tx, userId, now);
      return tx
        .select(SESSION_FIELDS)
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(desc(sessions.lastActivityAt), asc(sessions.sessionId))
        .all();
    })
    .map(toSession);

// `live` is the moment a session counts as gone.
const pastSessionsFrom = (db: TenantDb, live: number) =>
  db
    .select({
      sessionId: sessionHistory.sessionId,
      deviceName: sessionHistory.deviceName,
      agentName: sessionHistory.agentName,
      host: sessionHistory.host,
      cwd: sessionHistory.cwd,
      repo: sessionHistory.repo,
      branch: sessionHistory.branch,
      startedAt: sessionHistory.startedAt,
      lastActivityAt: sessionHistory.lastActivityAt,
      prompts: sessionHistory.prompts,
      focusFirst: sessionHistory.focusFirst,
      focusLatest: sessionHistory.focusLatest,
      running: sql<number>`${sessions.sessionId} IS NOT NULL`.as("running"),
    })
    .from(sessionHistory)
    .leftJoin(
      sessions,
      and(
        eq(sessions.userId, sessionHistory.userId),
        eq(sessions.sessionId, sessionHistory.sessionId),
        gt(sessions.lastActivityAt, live),
      ),
    );

interface PastSessionRow {
  sessionId: string;
  deviceName: string;
  agentName: string;
  host: string;
  cwd: string;
  repo: string;
  branch: string;
  startedAt: number;
  lastActivityAt: number;
  prompts: number;
  focusFirst: string;
  focusLatest: string;
  running: number;
}

const toPastSession = (row: PastSessionRow): PastSession => ({
  sessionId: row.sessionId,
  name: sessionHandle(row.deviceName, row.sessionId),
  agentName: row.agentName,
  host: row.host,
  cwd: row.cwd,
  repo: row.repo,
  branch: row.branch,
  startedAt: row.startedAt,
  lastActivityAt: row.lastActivityAt,
  prompts: row.prompts,
  focus: { first: row.focusFirst, latest: row.focusLatest },
  running: row.running === 1,
});

// session_history_by_activity and session_history_by_agent_name in that order.
const HISTORY_ORDERS: Record<string, Order<PastSession>> = {
  newest: {
    keyset: (at, id) =>
      sql`(${sessionHistory.lastActivityAt} < ${at}
        OR (${sessionHistory.lastActivityAt} = ${at} AND ${sessionHistory.sessionId} < ${id}))`,
    by: [desc(sessionHistory.lastActivityAt), desc(sessionHistory.sessionId)],
    direction: "desc",
    cursorOf: (session) => [session.lastActivityAt, session.sessionId],
  },
  agent: {
    keyset: (at, id) =>
      sql`(${sessionHistory.agentName} > ${at}
        OR (${sessionHistory.agentName} = ${at} AND ${sessionHistory.sessionId} > ${id}))`,
    by: [asc(sessionHistory.agentName), asc(sessionHistory.sessionId)],
    direction: "asc",
    cursorOf: (session) => [session.agentName, session.sessionId],
  },
};

export const historyCursorDirection = (sort: string): "desc" | "asc" => orderFor(HISTORY_ORDERS, sort).direction;

const hostAndRepo = (input: HistoryInput): SQL => {
  const host = input.host === "" ? sql`1 = 1` : eq(sessionHistory.host, input.host);
  const repo = input.repo === "" ? sql`1 = 1` : eq(sessionHistory.repo, input.repo);
  return sql`${host} AND ${repo}`;
};

export const listSessionHistory = async (
  db: TenantDb,
  userId: string,
  input: HistoryInput,
  [cursorAt, cursorSessionId]: Cursor,
  now: number,
): Promise<{ sessions: PastSession[]; nextCursor: string }> => {
  const order = orderFor(HISTORY_ORDERS, input.sort);
  const results = await pastSessionsFrom(db, now - SESSION_TTL_MS)
    .where(and(eq(sessionHistory.userId, userId), hostAndRepo(input), order.keyset(cursorAt, cursorSessionId)))
    .orderBy(...order.by)
    .limit(input.limit + 1)
    .all();
  const found = results.slice(0, input.limit).map(toPastSession);
  const last = found.at(-1);
  const nextCursor = results.length > input.limit && last ? encodeCursor(...order.cursorOf(last)) : "";
  return { sessions: found, nextCursor };
};

// History by what a session was about. The index stores its own copy of the focus, the commit
// subject and the agent name, so one match is one read of the history row beside it. A relevance
// order has no keyset, so a search is one bounded page and never carries a cursor.
export const searchSessionHistory = async (
  db: TenantDb,
  userId: string,
  input: HistoryInput,
  match: string,
  limit: number,
  now: number,
): Promise<{ sessions: PastSession[]; cut: boolean }> => {
  const results = await pastSessionsFrom(db, now - SESSION_TTL_MS)
    .innerJoin(
      sessionHistoryFts,
      and(
        eq(sessionHistoryFts.sessionId, sessionHistory.sessionId),
        eq(sessionHistoryFts.userId, sessionHistory.userId),
      ),
    )
    .where(and(sql`${sessionHistoryFts} MATCH ${match}`, eq(sessionHistory.userId, userId), hostAndRepo(input)))
    .orderBy(sql`bm25(${sessionHistoryFts})`)
    .limit(limit + 1)
    .all();
  return { sessions: results.slice(0, limit).map(toPastSession), cut: results.length > limit };
};

const SESSION_IDS_PAGE = 100;

// Which sessions the account has on record, and nothing else about them. A host reading its own
// past sessions back out of its transcripts needs only to know which ones are already here, and
// the ids alone page far cheaper than the rows the history tab draws.
//
// The page walks the session id and not the activity time the history tab orders by: a live session
// syncing while a caller pages rewrites its own last activity, and a row whose time moves under an
// ordering keyed on it hops across the cursor and is never read. An id never moves.
export const listSessionHistoryIds = async (
  db: TenantDb,
  userId: string,
  cursor: string,
): Promise<{ sessionIds: string[]; nextCursor: string }> => {
  const results = db
    .select({ sessionId: sessionHistory.sessionId })
    .from(sessionHistory)
    .where(and(eq(sessionHistory.userId, userId), gt(sessionHistory.sessionId, cursor)))
    .orderBy(asc(sessionHistory.sessionId))
    .limit(SESSION_IDS_PAGE + 1)
    .all();
  const page = results.slice(0, SESSION_IDS_PAGE);
  const last = page.at(-1);
  return {
    sessionIds: page.map((row) => row.sessionId),
    nextCursor: results.length > SESSION_IDS_PAGE && last ? last.sessionId : "",
  };
};

// How many sessions a name answered for, beside the one returned. A name recurs — the harness
// hands the same word to a session resumed weeks later — and the most recently active wins, which
// is the one a caller typing a name from memory means. The count rides along because `--restore`
// writes to disk off that pick, and a caller choosing between two sessions should be told there
// were two.
export interface FoundSession {
  session: PastSession;
  matches: number;
}

// How many of a device's sessions the handle branch reads before giving up. A handle is a
// function of the session id that SQL cannot compute — `sessionHandle` strips the id of
// everything but letters and digits before taking its head — so the rows are narrowed to the one
// device and the handle is checked here. Newest first, since a handle is something a caller just
// read off a listing.
const HANDLE_SCAN = 500;

// One session, by any of the three things that name it: its Claude Code session id, the name the
// harness gave it, or the handle `recall send` addresses it by.
export const findSession = async (
  db: TenantDb,
  userId: string,
  target: string,
  now: number,
): Promise<FoundSession | null> => {
  const gone = now - SESSION_TTL_MS;
  const found = pastSessionsFrom(db, gone)
    .where(
      and(
        eq(sessionHistory.userId, userId),
        or(eq(sessionHistory.sessionId, target), eq(sessionHistory.agentName, target)),
      ),
    )
    .as("found");
  const named = db
    .select({
      sessionId: found.sessionId,
      deviceName: found.deviceName,
      agentName: found.agentName,
      host: found.host,
      cwd: found.cwd,
      repo: found.repo,
      branch: found.branch,
      startedAt: found.startedAt,
      lastActivityAt: found.lastActivityAt,
      prompts: found.prompts,
      focusFirst: found.focusFirst,
      focusLatest: found.focusLatest,
      running: found.running,
      matches: sql<number>`COUNT(*) OVER ()`,
    })
    .from(found)
    .orderBy(desc(found.lastActivityAt), desc(found.sessionId))
    .limit(1)
    .get();
  if (named !== undefined) return { session: toPastSession(named), matches: named.matches };
  // A handle is a device name, a dash and the head of a session id, and the device name may hold
  // dashes of its own; the last dash is the one that splits them.
  const dash = target.lastIndexOf("-");
  if (dash <= 0) return null;
  const results = pastSessionsFrom(db, gone)
    .where(and(eq(sessionHistory.userId, userId), eq(sessionHistory.deviceName, target.slice(0, dash))))
    .orderBy(desc(sessionHistory.lastActivityAt), desc(sessionHistory.sessionId))
    .limit(HANDLE_SCAN)
    .all();
  const matched = results.filter((row) => sessionHandle(row.deviceName, row.sessionId) === target);
  const row = matched[0];
  return row ? { session: toPastSession(row), matches: matched.length } : null;
};

export const describeSessions = async (
  db: TenantDb,
  userId: string,
  sessionIds: string[],
  now: number,
): Promise<Map<string, PastSession>> => {
  const results = pastSessionsFrom(db, now - SESSION_TTL_MS)
    .where(and(eq(sessionHistory.userId, userId), sql`${sessionHistory.sessionId} IN ${jsonEach(sessionIds)}`))
    .all();
  return new Map(results.map((row) => [row.sessionId, toPastSession(row)]));
};

// The name the harness gave a session, learned from the head of its own transcript. It is written
// to both tables because the two carry a session at different points in its life: a live session
// has a row in each, and one already over has only the history row left.
export const nameSession = async (
  db: TenantDb,
  userId: string,
  sessionId: string,
  agentName: string,
): Promise<void> => {
  db.transaction((tx) => {
    tx.update(sessions)
      .set({ agentName })
      .where(and(eq(sessions.userId, userId), eq(sessions.sessionId, sessionId), eq(sessions.agentName, "")))
      .run();
    tx.update(sessionHistory)
      .set({ agentName })
      .where(
        and(
          eq(sessionHistory.userId, userId),
          eq(sessionHistory.sessionId, sessionId),
          eq(sessionHistory.agentName, ""),
        ),
      )
      .run();
  });
};

export const sessionHistoryFilters = async (db: TenantDb, userId: string): Promise<HistoryFilters> => {
  const hosts = db
    .selectDistinct({ field: sql<string>`'host'`.as("field"), value: sql<string>`${sessionHistory.host}`.as("value") })
    .from(sessionHistory)
    .where(and(eq(sessionHistory.userId, userId), ne(sessionHistory.host, "")));
  const repos = db
    .selectDistinct({ field: sql<string>`'repo'`.as("field"), value: sql<string>`${sessionHistory.repo}`.as("value") })
    .from(sessionHistory)
    .where(and(eq(sessionHistory.userId, userId), ne(sessionHistory.repo, "")));
  const results = unionAll(hosts, repos).orderBy(sql`field`, sql`value`).all();
  const values = (field: string): string[] => results.filter((row) => row.field === field).map((row) => row.value);
  return { hosts: values("host"), repos: values("repo") };
};

type LabelRow = { kind: LabelKind; value: string; label: string };

export const readLabels = async (db: TenantDb, userId: string): Promise<Labels> => {
  const results: LabelRow[] = db
    .select({ kind: labelsTable.kind, value: labelsTable.value, label: labelsTable.label })
    .from(labelsTable)
    .where(eq(labelsTable.userId, userId))
    .orderBy(asc(labelsTable.kind), asc(labelsTable.value))
    .all();
  const of = (kind: LabelKind): Map<string, string> =>
    new Map(results.filter((row) => row.kind === kind).map((row) => [row.value, row.label]));
  return { hosts: of("host"), accounts: of("account") };
};

// Every host and account the user has on record, live or past, plus the ones already labelled, so a
// label survives on the page that set it even once its value stops appearing in the data.
export const labelTargets = async (db: TenantDb, userId: string): Promise<LabelTargets> => {
  const targets = (table: SQLiteTable, kind: SQL<string>, value: SQLiteColumn, where: SQL | undefined) =>
    db
      .selectDistinct({ kind: kind.as("kind"), value: sql<string>`${value}`.as("value") })
      .from(table)
      .where(where);
  const mine = (owner: SQLiteColumn, value: SQLiteColumn) => and(eq(owner, userId), ne(value, ""));
  const results = union(
    targets(sessions, sql`'host'`, sessions.host, mine(sessions.userId, sessions.host)),
    targets(sessionHistory, sql`'host'`, sessionHistory.host, mine(sessionHistory.userId, sessionHistory.host)),
    targets(usageDaily, sql`'host'`, usageDaily.host, mine(usageDaily.userId, usageDaily.host)),
    targets(usageDaily, sql`'account'`, usageDaily.account, mine(usageDaily.userId, usageDaily.account)),
    targets(labelsTable, sql`${labelsTable.kind}`, labelsTable.value, eq(labelsTable.userId, userId)),
  )
    .orderBy(sql`kind`, sql`value`)
    .all();
  const values = (kind: string): string[] => results.filter((row) => row.kind === kind).map((row) => row.value);
  return { hosts: values("host"), accounts: values("account") };
};

export const writeLabels = async (db: TenantDb, userId: string, labels: Label[]): Promise<void> => {
  if (labels.length === 0) return;
  db.transaction((tx) => {
    for (const entry of labels) {
      if (entry.label === "") {
        tx.delete(labelsTable)
          .where(
            and(eq(labelsTable.userId, userId), eq(labelsTable.kind, entry.kind), eq(labelsTable.value, entry.value)),
          )
          .run();
        continue;
      }
      tx.insert(labelsTable)
        .values({ userId, kind: entry.kind, value: entry.value, label: entry.label })
        .onConflictDoUpdate({
          target: [labelsTable.userId, labelsTable.kind, labelsTable.value],
          set: { label: sql`excluded.label` },
        })
        .run();
    }
  });
};

type CountRow = {
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

type ModelRow = CountRow & { provider: string; model: string };

const countSums = (table: typeof usageDaily | typeof usageEvents) => ({
  prompts: sql<number>`COALESCE(SUM(${table.prompts}), 0)`,
  inputTokens: sql<number>`COALESCE(SUM(${table.inputTokens}), 0)`,
  outputTokens: sql<number>`COALESCE(SUM(${table.outputTokens}), 0)`,
  cacheWriteTokens: sql<number>`COALESCE(SUM(${table.cacheWriteTokens}), 0)`,
  cacheReadTokens: sql<number>`COALESCE(SUM(${table.cacheReadTokens}), 0)`,
});

const toCounts = (row: CountRow): TokenCounts => ({
  prompts: row.prompts,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheWriteTokens: row.cacheWriteTokens,
  cacheReadTokens: row.cacheReadTokens,
});

const toModelTotals = (row: ModelRow): ModelTotals => ({
  provider: row.provider,
  model: row.model,
  ...toCounts(row),
});

// Every window the pages draw reads the daily rollup and nothing else: the counters land in
// usage_daily on the same write that records the raw event, so the current day is already live
// there and no window ever touches usage_events.
const usageDays = (db: TenantTx, userId: string, fromDay: string) =>
  db
    .select({
      bucket: usageDaily.day,
      provider: usageDaily.provider,
      model: usageDaily.model,
      ...countSums(usageDaily),
    })
    .from(usageDaily)
    .where(and(eq(usageDaily.userId, userId), gte(usageDaily.day, fromDay)))
    .groupBy(usageDaily.day, usageDaily.provider, usageDaily.model)
    .orderBy(asc(usageDaily.day), asc(usageDaily.provider), asc(usageDaily.model));

// The month a delta falls in is the month of the UTC day the rollup already keyed it under, so the
// long horizon reads the same column the windows do and the two can never disagree.
const usageMonths = (db: TenantTx, userId: string) => {
  const month = sql<string>`substr(${usageDaily.day}, 1, 7)`;
  return db
    .select({ bucket: month, provider: usageDaily.provider, model: usageDaily.model, ...countSums(usageDaily) })
    .from(usageDaily)
    .where(eq(usageDaily.userId, userId))
    .groupBy(month, usageDaily.provider, usageDaily.model)
    .orderBy(month, asc(usageDaily.provider), asc(usageDaily.model));
};

const usageSplit = (db: TenantTx, userId: string, fromDay: string, field: UsageSplitField, value: SQLiteColumn) =>
  db
    .select({
      field: sql<UsageSplitField>`${field}`.as("field"),
      value: sql<string>`${value}`.as("value"),
      provider: usageDaily.provider,
      model: usageDaily.model,
      ...countSums(usageDaily),
    })
    .from(usageDaily)
    .where(and(eq(usageDaily.userId, userId), gte(usageDaily.day, fromDay)))
    .groupBy(value, usageDaily.provider, usageDaily.model);

const usageSplits = (db: TenantTx, userId: string, fromDay: string) =>
  unionAll(
    usageSplit(db, userId, fromDay, "host", usageDaily.host),
    usageSplit(db, userId, fromDay, "repo", usageDaily.repo),
    usageSplit(db, userId, fromDay, "account", usageDaily.account),
  );

const sessionsPerDay = (db: TenantTx, userId: string, since: number) => {
  const day = sql<string>`date(${sessionHistory.startedAt} / 1000, 'unixepoch')`;
  return db
    .select({ day, sessions: count() })
    .from(sessionHistory)
    .where(and(eq(sessionHistory.userId, userId), gte(sessionHistory.startedAt, since)))
    .groupBy(day)
    .orderBy(day);
};

// A session that opened before the window or runs past its end only lends the stretch that falls
// inside it, so a months-old session touching a repo yesterday cannot donate its whole life to the
// fortnight. Overlapping sessions still each count their own stretch: this is session time, not
// wall-clock time, and the page says so. The all-time ranking passes since 0, which leaves the clip
// at now and nothing else.
const repoHours = (db: TenantTx, userId: string, since: number, until: number, limit: number) => {
  const ms = sql<number>`SUM(MAX(MIN(${sessionHistory.lastActivityAt}, ${until})
    - MAX(${sessionHistory.startedAt}, ${since}), 0))`;
  return db
    .select({ repo: sessionHistory.repo, ms, sessions: count() })
    .from(sessionHistory)
    .where(
      and(
        eq(sessionHistory.userId, userId),
        gte(sessionHistory.lastActivityAt, since),
        lte(sessionHistory.startedAt, until),
      ),
    )
    .groupBy(sessionHistory.repo)
    .orderBy(desc(ms), asc(sessionHistory.repo))
    .limit(limit);
};

const rhythm = (db: TenantTx, userId: string, since: number) => {
  const weekday = sql<number>`CAST(strftime('%w', ${sessionHistory.startedAt} / 1000, 'unixepoch') AS INTEGER)`;
  const hour = sql<number>`CAST(strftime('%H', ${sessionHistory.startedAt} / 1000, 'unixepoch') AS INTEGER)`;
  return db
    .select({ weekday, hour, sessions: count() })
    .from(sessionHistory)
    .where(and(eq(sessionHistory.userId, userId), gte(sessionHistory.startedAt, since)))
    .groupBy(weekday, hour)
    .orderBy(desc(count()), weekday, hour);
};

const workingSet = (db: TenantTx, userId: string, since: number, limit: number) =>
  db
    .select({
      name: memories.name,
      recallCount: memories.recallCount,
      totalRecalls: sql<number>`SUM(${memories.recallCount}) OVER ()`,
    })
    .from(memories)
    .where(and(eq(memories.userId, userId), gt(memories.recallCount, 0), gte(memories.lastRecalledAt, since)))
    .orderBy(desc(memories.recallCount), asc(memories.name))
    .limit(limit);

const staleMemories = (db: TenantTx, userId: string, staleBefore: number, savedBefore: number, limit: number) =>
  db
    .select({
      name: memories.name,
      recallCount: memories.recallCount,
      lastRecalledAt: memories.lastRecalledAt,
      createdAt: memories.createdAt,
      atRisk: sql<number>`COUNT(*) OVER ()`,
    })
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        or(
          and(gt(memories.recallCount, 0), lt(memories.lastRecalledAt, staleBefore)),
          and(eq(memories.recallCount, 0), lt(memories.createdAt, savedBefore)),
        ),
      ),
    )
    .orderBy(
      sql`(CASE WHEN ${memories.recallCount} = 0 THEN ${memories.createdAt} ELSE ${memories.lastRecalledAt} END)`,
      asc(memories.name),
    )
    .limit(limit);

const WORKING_SET_SIZE = 5;
const STALE_LIST_SIZE = 5;
const REPO_BAR_COUNT = 5;

// The sidebar's live summary, on every dashboard page: one transaction for the expiry sweep, the
// live and busy counts, today's sessions and today's tokens, which the page prices on render.
export const liveTally = async (db: TenantDb, userId: string, now: number): Promise<Live> =>
  db.transaction((tx) => {
    expireSessions(tx, userId, now);
    const idle = now - IDLE_AFTER_MS;
    const gone = now - SESSION_TTL_MS;
    const tally = tx.get<{ sessions: number; busy: number; sessions_today: number }>(sql`
      SELECT
        (SELECT COUNT(*) FROM ${sessions}
           WHERE ${sessions.userId} = ${userId} AND ${sessions.lastActivityAt} > ${gone}) AS sessions,
        (SELECT COALESCE(SUM(${sessions.lastActivityAt} > ${idle}), 0) FROM ${sessions}
           WHERE ${sessions.userId} = ${userId} AND ${sessions.lastActivityAt} > ${gone}) AS busy,
        (SELECT COUNT(*) FROM ${sessionHistory}
           WHERE ${sessionHistory.userId} = ${userId}
             AND ${sessionHistory.startedAt} >= ${usageDayStart(now)}) AS sessions_today`);
    const today = tx
      .select({ provider: usageDaily.provider, model: usageDaily.model, ...countSums(usageDaily) })
      .from(usageDaily)
      .where(and(eq(usageDaily.userId, userId), eq(usageDaily.day, usageDay(now))))
      .groupBy(usageDaily.provider, usageDaily.model)
      .all();
    return {
      sessions: tally?.sessions ?? 0,
      busy: tally?.busy ?? 0,
      sessionsToday: tally?.sessions_today ?? 0,
      today: today.map(toModelTotals),
    };
  });

export const readStats = async (db: TenantDb, userId: string, windows: StatsWindows): Promise<Stats> =>
  db.transaction((tx) => {
    const usage = usageDays(tx, userId, windows.month.from).all();
    const splits = usageSplits(tx, userId, windows.month.from).all();
    const perDay = sessionsPerDay(tx, userId, windows.month.since).all();
    return {
      windows,
      usage: usage.map((row) => ({ bucket: row.bucket, ...toModelTotals(row) })),
      splits: splits.map((row) => ({ field: row.field, value: row.value, ...toModelTotals(row) })),
      sessions: perDay.map((row) => ({ day: row.day, sessions: row.sessions })),
    };
  });

// The Insights page, off one round trip. The sessions, the usage, the repositories and the memory
// counters are all this account's own rows, so the whole page is one transaction against its own
// object and nothing on it joins across the split.
export const readInsights = async (
  db: TenantDb,
  userId: string,
  fortnight: DayWindow,
  now: number,
): Promise<Insights> => {
  const read = db.transaction((tx) => ({
    usage: usageDays(tx, userId, fortnight.from).all(),
    monthly: usageMonths(tx, userId).all(),
    repos: repoHours(tx, userId, fortnight.since, fortnight.until, REPO_BAR_COUNT).all(),
    allTime: repoHours(tx, userId, 0, now, REPO_BAR_COUNT).all(),
    rhythm: rhythm(tx, userId, fortnight.since).all(),
    recalls: workingSet(tx, userId, usageDayStart(now) - (USAGE_MONTH_DAYS - 1) * DAY_MS, WORKING_SET_SIZE).all(),
    stale: staleMemories(
      tx,
      userId,
      now - STALE_AFTER_DAYS * DAY_MS,
      now - NEVER_RECALLED_AFTER_DAYS * DAY_MS,
      STALE_LIST_SIZE,
    ).all(),
    total: tx.select({ memories: count() }).from(memories).where(eq(memories.userId, userId)).all(),
  }));
  return {
    fortnight,
    usage: read.usage.map((row) => ({ bucket: row.bucket, ...toModelTotals(row) })),
    monthly: read.monthly.map((row) => ({ bucket: row.bucket, ...toModelTotals(row) })),
    working: {
      entries: read.recalls.map((row) => ({ name: row.name, recalls: row.recallCount })),
      recalls: read.recalls[0]?.totalRecalls ?? 0,
    },
    stale: {
      entries: read.stale.map((row) => ({
        name: row.name,
        recalled: row.recallCount > 0,
        lastRecalledAt: row.lastRecalledAt,
        createdAt: row.createdAt,
      })),
      atRisk: read.stale[0]?.atRisk ?? 0,
      total: read.total[0]?.memories ?? 0,
    },
    repos: read.repos.map((row) => ({ repo: row.repo, ms: row.ms, sessions: row.sessions })),
    allTime: read.allTime.map((row) => ({ repo: row.repo, ms: row.ms, sessions: row.sessions })),
    rhythm: read.rhythm.map((row) => ({ weekday: row.weekday, hour: row.hour, sessions: row.sessions })),
  };
};

// The device one session is live on, which is the only address a message to it can carry. A
// session the account no longer has running has none, and saying so is what stops the dashboard
// queueing a message no host will ever read.
export const liveSessionDevice = async (
  db: TenantDb,
  userId: string,
  sessionId: string,
  now: number,
): Promise<string | null> => {
  const row = db
    .select({ deviceId: sessions.deviceId })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.sessionId, sessionId),
        gt(sessions.lastActivityAt, now - SESSION_TTL_MS),
      ),
    )
    .get();
  return row === undefined ? null : row.deviceId;
};

export const sessionOnDevice = async (
  db: TenantDb,
  userId: string,
  sessionId: string,
  deviceId: string,
  now: number,
): Promise<boolean> => (await liveSessionDevice(db, userId, sessionId, now)) === deviceId;

// What one session spent, and on whose account. The rollup cannot answer either: it is keyed by
// day, host, repo and account and never by session, so the raw events are the only reading that
// holds a session together. They are swept at two weeks unless the reading was taken from the
// transcript, and the page says that rather than printing an old session's spend as nothing.
export const sessionSpend = async (db: TenantDb, userId: string, sessionId: string): Promise<SessionSpend[]> => {
  const results = db
    .select({
      account: usageEvents.account,
      provider: usageEvents.provider,
      model: usageEvents.model,
      ...countSums(usageEvents),
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.sessionId, sessionId)))
    .groupBy(usageEvents.account, usageEvents.provider, usageEvents.model)
    .orderBy(asc(usageEvents.account), asc(usageEvents.provider), asc(usageEvents.model))
    .all();
  return results.map((row) => ({ account: row.account, ...toModelTotals(row) }));
};

// Whether this account has the session at all, running or long over. A transcript outlives the
// device that wrote it — a host signs in again and carries a new device id — so what a stretch is
// checked against is the account, and the object key it lands under is the caller's own.
export const sessionOnRecord = async (db: TenantDb, userId: string, sessionId: string): Promise<boolean> => {
  const live = db
    .select({ sessionId: sessions.sessionId })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.sessionId, sessionId)));
  const past = db
    .select({ sessionId: sessionHistory.sessionId })
    .from(sessionHistory)
    .where(and(eq(sessionHistory.userId, userId), eq(sessionHistory.sessionId, sessionId)));
  return unionAll(live, past).limit(1).all().length === 1;
};

export const recordUsage = async (
  db: TenantDb,
  userId: string,
  sessionId: string,
  input: UsageInput,
  now: number,
): Promise<void> => {
  const counters = {
    prompts: input.prompts,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    cacheReadTokens: input.cacheReadTokens,
  };
  db.transaction((tx) => {
    // The rollup moves only where the raw event is new, which is what makes a redelivered delta
    // count once: a guard on another table is a shape the insert builder's `values` cannot take.
    tx.insert(usageDaily)
      .select(
        sql`SELECT ${userId}, ${usageDay(input.at)}, ${input.host}, ${input.repo}, ${input.account},
          ${input.provider}, ${input.model}, ${counters.prompts}, ${counters.inputTokens},
          ${counters.outputTokens}, ${counters.cacheWriteTokens}, ${counters.cacheReadTokens}
        WHERE NOT EXISTS (SELECT 1 FROM ${usageEvents}
          WHERE ${usageEvents.userId} = ${userId} AND ${usageEvents.sessionId} = ${sessionId}
            AND ${usageEvents.seq} = ${input.seq})`,
      )
      .onConflictDoUpdate({
        target: [
          usageDaily.userId,
          usageDaily.day,
          usageDaily.host,
          usageDaily.repo,
          usageDaily.account,
          usageDaily.provider,
          usageDaily.model,
        ],
        set: {
          prompts: sql`usage_daily.prompts + excluded.prompts`,
          inputTokens: sql`usage_daily.input_tokens + excluded.input_tokens`,
          outputTokens: sql`usage_daily.output_tokens + excluded.output_tokens`,
          cacheWriteTokens: sql`usage_daily.cache_write_tokens + excluded.cache_write_tokens`,
          cacheReadTokens: sql`usage_daily.cache_read_tokens + excluded.cache_read_tokens`,
        },
      })
      .run();
    tx.insert(usageEvents)
      .values({
        userId,
        sessionId,
        seq: input.seq,
        provider: input.provider,
        account: input.account,
        model: input.model,
        ...counters,
        at: input.at,
        recordedAt: now,
        durable: input.durable ? 1 : 0,
      })
      .onConflictDoNothing()
      .run();
    tx.delete(usageEvents)
      .where(
        and(
          eq(usageEvents.userId, userId),
          lt(usageEvents.recordedAt, now - USAGE_RETENTION_MS),
          eq(usageEvents.durable, 0),
        ),
      )
      .run();
    // One statement per file, never one insert of many rows: SQLite binds at most a hundred
    // parameters to a statement, and a session can carry more files than that.
    for (const file of input.files) {
      tx.insert(countedFilesTable).values({ userId, sessionId, file }).onConflictDoNothing().run();
    }
  });
};

// How far one session's archive runs and how far the index has read of it. `archived` is a cache
// of the objects, moved by the storage event that wrote them; `indexed` and `chunks` are the
// index's own and no listing could recover them.
export interface IndexMark {
  archived: number;
  indexed: number;
  chunks: number;
}

export const indexMark = async (db: TenantDb, userId: string, sessionId: string): Promise<IndexMark | null> =>
  db
    .select({ archived: sessionIndex.archived, indexed: sessionIndex.bytes, chunks: sessionIndex.chunks })
    .from(sessionIndex)
    .where(and(eq(sessionIndex.userId, userId), eq(sessionIndex.sessionId, sessionId)))
    .get() ?? null;

export interface IndexedChunk {
  speaker: Speaker;
  text: string;
  at: number;
  embedding: Uint8Array;
}

// A session is off the record mark while it holds no row for its own transcript. Every statement
// the two indexing paths write carries it, so a session taken over by a replay stops the other
// path dead rather than letting the two write the same prose twice.
const offRecord = (userId: string, sessionId: string): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM ${sessionRecords}
    WHERE ${sessionRecords.userId} = ${userId} AND ${sessionRecords.sessionId} = ${sessionId}
      AND ${sessionRecords.file} = ${MAIN_FILE})`;

// What one indexing pass produced, written in one batch with the mark that says how far it read.
// The chunks are appended under ordinals that only climb, so a session indexed again after it was
// resumed adds to what is there and nothing already indexed is rewritten or lost.
//
// It all lands in one batch, and every statement of it lands only while the session is off the
// record mark. A session taken over by a replay goes on the mark in the batch that drops the
// chunks this path wrote, so a pass that read its bite before the takeover and writes after it
// writes nothing at all: there is no ordering of the two that leaves one session holding chunks
// from both paths.
export const writeChunks = async (
  db: TenantDb,
  userId: string,
  sessionId: string,
  from: number,
  chunks: IndexedChunk[],
  reached: number,
): Promise<void> => {
  db.transaction((tx) => {
    chunks.forEach((chunk, index) => {
      tx.insert(sessionChunks)
        .select(
          sql`SELECT NULL, ${userId}, ${sessionId}, ${from + index}, ${chunk.speaker}, ${chunk.text},
            ${blobOf(chunk.embedding)}, ${chunk.at}
          WHERE ${offRecord(userId, sessionId)}`,
        )
        .onConflictDoNothing({ target: [sessionChunks.userId, sessionChunks.sessionId, sessionChunks.ordinal] })
        .run();
    });
    tx.update(sessionIndex)
      .set({ bytes: reached, chunks: from + chunks.length })
      .where(and(eq(sessionIndex.userId, userId), eq(sessionIndex.sessionId, sessionId), offRecord(userId, sessionId)))
      .run();
  });
};

export interface ChunkCandidate {
  chunkSeq: number;
  sessionId: string;
  speaker: string;
  embedding: Uint8Array;
}

// The chunks a search scores, without their text: the ones the full-text pass already named, and
// the newest `recent` the account holds whatever the query was. A vector is 388 bytes, so the set
// is tens of kilobytes and its cost stays flat as the archive grows, where reading every row made
// a search cost more every week. `chunk_seq` only ever climbs, so the newest are the highest and
// the floor is one scalar read. The prose is read back only for the chunks that win, since
// carrying it here would be ten times the bytes.
export const chunkVectors = async (
  db: TenantDb,
  userId: string,
  chunkSeqs: readonly number[],
  recent: number,
): Promise<ChunkCandidate[]> => {
  const rows = db.values<[number, string, string, unknown]>(sql`
    SELECT ${sessionChunks.chunkSeq}, ${sessionChunks.sessionId}, ${sessionChunks.speaker}, ${sessionChunks.embedding}
    FROM ${sessionChunks}
    WHERE ${sessionChunks.userId} = ${userId}
      AND (${sessionChunks.chunkSeq} IN ${jsonEach(chunkSeqs)} OR ${sessionChunks.chunkSeq} >= (
        SELECT MIN(chunk_seq) FROM (
          SELECT ${sessionChunks.chunkSeq} FROM ${sessionChunks}
          WHERE ${sessionChunks.userId} = ${userId}
          ORDER BY ${sessionChunks.chunkSeq} DESC LIMIT ${recent})))`);
  return rows.map(([chunkSeq, sessionId, speaker, embedding]) => ({
    chunkSeq,
    sessionId,
    speaker,
    embedding: toBytes(embedding),
  }));
};

export interface ChunkMatch {
  chunkSeq: number;
  sessionId: string;
  speaker: string;
}

export const chunkMatches = async (db: TenantDb, userId: string, match: string, limit: number): Promise<ChunkMatch[]> =>
  db
    .select({
      chunkSeq: sessionChunks.chunkSeq,
      sessionId: sessionChunks.sessionId,
      speaker: sessionChunks.speaker,
    })
    .from(sessionChunksFts)
    .innerJoin(sessionChunks, eq(sessionChunks.chunkSeq, sessionChunksFts.rowid))
    .where(and(sql`${sessionChunksFts} MATCH ${match}`, eq(sessionChunks.userId, userId)))
    .orderBy(sql`bm25(${sessionChunksFts})`)
    .limit(limit)
    .all();

export interface Excerpt {
  speaker: Speaker;
  text: string;
  at: number;
}

export const chunkExcerpts = async (
  db: TenantDb,
  userId: string,
  chunkSeqs: number[],
): Promise<Map<number, Excerpt>> => {
  const results = db
    .select({
      chunkSeq: sessionChunks.chunkSeq,
      speaker: sessionChunks.speaker,
      text: sessionChunks.text,
      at: sessionChunks.at,
    })
    .from(sessionChunks)
    .where(and(eq(sessionChunks.userId, userId), sql`${sessionChunks.chunkSeq} IN ${jsonEach(chunkSeqs)}`))
    .all();
  return new Map(results.map((row) => [row.chunkSeq, { speaker: row.speaker, text: row.text, at: row.at }]));
};

// The transcript files of one session whose tokens have been counted, whoever counted them: the
// hooks as the session ran, or a run reading the file back long after. It is the only thing a
// later reading can ask, since the raw events are swept at two weeks and never said which file
// they read.
export const countedFiles = async (db: TenantDb, userId: string, sessionId: string): Promise<string[]> =>
  db
    .select({ file: countedFilesTable.file })
    .from(countedFilesTable)
    .where(and(eq(countedFilesTable.userId, userId), eq(countedFilesTable.sessionId, sessionId)))
    .orderBy(asc(countedFilesTable.file))
    .all()
    .map((row) => row.file);

interface ArtifactRow {
  name: string;
  rev: number;
  type: ArtifactType;
  title: string;
  description: string;
  readPerm: ReadPermission;
  writePerm: WritePermission;
  entryPath: string;
  files: string;
  fileCount: number;
  bytes: number;
  createdAt: number;
  updatedAt: number;
  userId: string;
  lastWriter: string;
}

// `lastWriter` is the address the publish wrote onto the row. An account whose emails had all been
// withdrawn when it published names none, which is the empty string the refusal already prints as
// "a device of this account".
const ARTIFACT_FIELDS = {
  name: artifacts.name,
  rev: artifacts.rev,
  type: artifacts.type,
  title: artifacts.title,
  description: artifacts.description,
  readPerm: artifacts.readPerm,
  writePerm: artifacts.writePerm,
  entryPath: artifacts.entryPath,
  files: artifacts.files,
  fileCount: artifacts.fileCount,
  bytes: artifacts.bytes,
  createdAt: artifacts.createdAt,
  updatedAt: artifacts.updatedAt,
  userId: artifacts.userId,
  lastWriter: artifacts.lastWriter,
};

const toArtifact = (row: ArtifactRow): ArtifactRecord => ({
  name: row.name,
  rev: row.rev,
  type: row.type,
  title: row.title,
  description: row.description,
  read: row.readPerm,
  write: row.writePerm,
  entryPath: row.entryPath,
  files: JSON.parse(row.files) as ArtifactFile[],
  fileCount: row.fileCount,
  bytes: row.bytes,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ownerUserId: row.userId,
  lastWriter: row.lastWriter,
});

// artifacts_by_updated, the unique (user_id, name) and artifacts_by_bytes in that order.
const ARTIFACT_ORDERS: Record<string, Order<ArtifactRecord>> = {
  newest: {
    keyset: (at, name) =>
      sql`(${artifacts.updatedAt} < ${at} OR (${artifacts.updatedAt} = ${at} AND ${artifacts.name} > ${name}))`,
    by: [desc(artifacts.updatedAt), asc(artifacts.name)],
    direction: "desc",
    cursorOf: (artifact) => [artifact.updatedAt, artifact.name],
  },
  name: {
    keyset: (at) => sql`${artifacts.name} > ${at}`,
    by: [asc(artifacts.name)],
    direction: "asc",
    cursorOf: (artifact) => [artifact.name, artifact.name],
  },
  largest: {
    keyset: (at, name) =>
      sql`(${artifacts.bytes} < ${at} OR (${artifacts.bytes} = ${at} AND ${artifacts.name} > ${name}))`,
    by: [desc(artifacts.bytes), asc(artifacts.name)],
    direction: "desc",
    cursorOf: (artifact) => [artifact.bytes, artifact.name],
  },
};

export const artifactCursorDirection = (sort: string): "desc" | "asc" => orderFor(ARTIFACT_ORDERS, sort).direction;

export interface ArtifactPage {
  artifacts: ArtifactRecord[];
  nextCursor: string;
}

export interface ArtifactMatches {
  artifacts: ArtifactRecord[];
  cut: boolean;
}

// What reading an artifact asks of a store. Every member names the account whose rows it wants,
// because the Worker hands this to a reader that reaches whichever object a name resolved to
// while the tenant object hands over its own; neither can read a row it was not asked for.
export interface ArtifactReads {
  artifact(userId: string, name: string): Promise<ArtifactRecord | null>;
  artifactPage(userId: string, input: ArtifactListInput, cursor: Cursor): Promise<ArtifactPage>;
  artifactMatches(userId: string, type: string, match: string, limit: number): Promise<ArtifactMatches>;
  artifactTally(userId: string): Promise<ArtifactCounts>;
}

// The writes beside them, which only the Worker's collection makes.
export interface ArtifactStore extends ArtifactReads {
  claimArtifactRevision(userId: string, name: string): Promise<number>;
  createArtifact(commit: ArtifactCommit): Promise<boolean>;
  replaceArtifact(commit: ArtifactCommit, fromRev: number): Promise<boolean>;
  deleteArtifact(userId: string, name: string): Promise<void>;
  adoptArtifacts(userId: string): Promise<number>;
  // The one-shot copy out of D1, which `./artifact-copy` holds and an operator drives once per
  // account. It sits on the write side because it writes, and on no read path at all.
  copyArtifacts(userId: string, now: number): Promise<ArtifactCopyReport>;
}

export const getArtifact = async (db: TenantDb, userId: string, name: string): Promise<ArtifactRecord | null> => {
  const row = db
    .select(ARTIFACT_FIELDS)
    .from(artifacts)
    .where(and(eq(artifacts.userId, userId), eq(artifacts.name, name)))
    .get();
  return row === undefined ? null : toArtifact(row);
};

const ofType = (type: string): SQL => (type === "" ? sql`1 = 1` : eq(artifacts.type, sql`${type}`));

export const listArtifactPage = async (
  db: TenantDb,
  userId: string,
  input: ArtifactListInput,
  [cursorAt, cursorName]: Cursor,
): Promise<{ artifacts: ArtifactRecord[]; nextCursor: string }> => {
  const order = orderFor(ARTIFACT_ORDERS, input.sort);
  const results = db
    .select(ARTIFACT_FIELDS)
    .from(artifacts)
    .where(and(eq(artifacts.userId, userId), ofType(input.type), order.keyset(cursorAt, cursorName)))
    .orderBy(...order.by)
    .limit(input.limit + 1)
    .all();
  const page = results.slice(0, input.limit).map(toArtifact);
  const last = page.at(-1);
  const nextCursor = results.length > input.limit && last ? encodeCursor(...order.cursorOf(last)) : "";
  return { artifacts: page, nextCursor };
};

// The shelf by what a reader typed, name heaviest, then title, then description — the weights the
// memory search already uses over the same three fields.
export const searchArtifacts = async (
  db: TenantDb,
  userId: string,
  type: string,
  match: string,
  limit: number,
): Promise<{ artifacts: ArtifactRecord[]; cut: boolean }> => {
  const results = db
    .select(ARTIFACT_FIELDS)
    .from(artifactsFts)
    .innerJoin(artifacts, eq(artifacts.artifactSeq, artifactsFts.rowid))
    .where(and(sql`${artifactsFts} MATCH ${match}`, eq(artifacts.userId, userId), ofType(type)))
    .orderBy(sql`bm25(${artifactsFts}, 5.0, 2.0, 1.0)`)
    .limit(limit + 1)
    .all();
  return { artifacts: results.slice(0, limit).map(toArtifact), cut: results.length > limit };
};

export interface ArtifactCounts {
  total: number;
  byType: Array<{ type: ArtifactType; count: number }>;
}

// The second read a page of the shelf costs: the total for the heading and a count per type for
// the chips. It walks the account's own rows, which is what the memory counts already do.
export const artifactCounts = async (db: TenantDb, userId: string): Promise<ArtifactCounts> => {
  const results = db
    .select({ type: artifacts.type, n: count() })
    .from(artifacts)
    .where(eq(artifacts.userId, userId))
    .groupBy(artifacts.type)
    .all();
  const counted = new Map(results.map((row) => [row.type, row.n]));
  return {
    total: results.reduce((running, row) => running + row.n, 0),
    byType: artifactTypes.filter((type) => counted.has(type)).map((type) => ({ type, count: counted.get(type) ?? 0 })),
  };
};

export interface ArtifactCommit {
  userId: string;
  name: string;
  rev: number;
  type: ArtifactType;
  title: string;
  description: string;
  read: ReadPermission;
  write: WritePermission;
  files: ArtifactFile[];
  at: number;
  writer: string;
}

// The revision the caller owns, claimed before a byte of it is written. The upsert is what makes
// the claim exclusive: two publishes of one name read the same live revision and each is handed a
// different number here, so neither streams into the prefix the other will commit.
export const claimRevision = async (db: TenantDb, userId: string, name: string): Promise<number> => {
  const row = db
    .insert(artifactRevisions)
    .values({ userId, name, revNext: 1 })
    .onConflictDoUpdate({
      target: [artifactRevisions.userId, artifactRevisions.name],
      set: { revNext: sql`${artifactRevisions.revNext} + 1` },
    })
    .returning({ revNext: artifactRevisions.revNext })
    .get();
  if (row === undefined) throw new Error(`claiming a revision of ${name} returned no row`);
  return row.revNext;
};

const entryOf = (commit: ArtifactCommit): ArtifactFile => {
  const entry = commit.files[0];
  if (entry === undefined) throw new Error(`a publish of ${commit.name} named no file`);
  return entry;
};

const bytesOf = (commit: ArtifactCommit): number => commit.files.reduce((running, file) => running + file.bytes, 0);

const artifactValues = (commit: ArtifactCommit) => ({
  userId: commit.userId,
  name: commit.name,
  rev: commit.rev,
  type: commit.type,
  title: commit.title,
  description: commit.description,
  readPerm: commit.read,
  writePerm: commit.write,
  entryPath: entryOf(commit).path,
  files: JSON.stringify(commit.files),
  fileCount: commit.files.length,
  bytes: bytesOf(commit),
  updatedAt: commit.at,
  lastWriter: commit.writer,
});

// The publish of a name that held nothing when the gates ran. `UNIQUE (user_id, name)` is what
// decides a race between two first publishes: the second writes no row and is told the name is
// taken rather than replacing what the first one just committed.
export const createArtifact = async (db: TenantDb, commit: ArtifactCommit): Promise<boolean> => {
  const written = db
    .insert(artifacts)
    .values({ ...artifactValues(commit), createdAt: commit.at })
    .onConflictDoNothing({ target: [artifacts.userId, artifacts.name] })
    .returning({ name: artifacts.name })
    .all();
  return written.length > 0;
};

// The publish of a name that held an artifact. The WHERE makes it a compare-and-swap on the
// revision read before the write: of two publishes racing under one name, one moves the row
// forward and the other changes nothing and is told so. A row that has since been unpublished
// matches nothing, so the publish is refused rather than recreating an artifact whose files the
// unpublish has already deleted. `created_at` is left alone, because the artifact is being
// replaced and not recreated.
export const replaceArtifact = async (db: TenantDb, commit: ArtifactCommit, fromRev: number): Promise<boolean> => {
  const written = db
    .update(artifacts)
    .set(artifactValues(commit))
    .where(and(eq(artifacts.userId, commit.userId), eq(artifacts.name, commit.name), eq(artifacts.rev, fromRev)))
    .returning({ name: artifacts.name })
    .all();
  return written.length > 0;
};

export const deleteArtifact = async (db: TenantDb, userId: string, name: string): Promise<void> => {
  db.delete(artifacts)
    .where(and(eq(artifacts.userId, userId), eq(artifacts.name, name)))
    .run();
};

// What the account store holds of a name once the artifact itself is gone: every share keyed to it
// and the claim on the name. One batch, because a failure between the two would leave shares
// keyed to a name no artifact holds and a later publish of that name would revive them.
export const releaseArtifactName = async (db: AccountDb, userId: string, name: string): Promise<void> => {
  await db.batch([
    db.delete(artifactShares).where(and(eq(artifactShares.userId, userId), eq(artifactShares.name, name))),
    db.delete(artifactNames).where(and(eq(artifactNames.name, name), eq(artifactNames.userId, userId))),
  ]);
};

export interface ArtifactRoute {
  userId: string;
  readPerm: ReadPermission;
}

// Which account a name on the artifact hostname belongs to. One read, and the only read that
// crosses accounts: what the name holds is then read out of that account's own object.
export const artifactRoute = async (db: AccountDb, name: string): Promise<ArtifactRoute | null> => {
  const row = await db
    .select({ userId: artifactNames.userId, readPerm: artifactNames.readPerm })
    .from(artifactNames)
    .where(eq(artifactNames.name, name))
    .get();
  return row ?? null;
};

// The claim on a name, which is the whole of what makes a publish's address unambiguous. A name
// nobody holds is taken outright; a name this account already holds has its permission moved; and
// a name another account holds is taken only where that account published it privately and this
// publish is for the whole account to read. Anything else writes nothing and is refused.
export const claimArtifactName = async (
  db: AccountDb,
  userId: string,
  name: string,
  readPerm: ReadPermission,
): Promise<boolean> => {
  const claimed = await db
    .insert(artifactNames)
    .values({ name, userId, readPerm })
    .onConflictDoUpdate({
      target: artifactNames.name,
      set: { userId: sql`excluded.user_id`, readPerm: sql`excluded.read_perm` },
      setWhere: or(
        eq(artifactNames.userId, sql`excluded.user_id`),
        and(eq(artifactNames.readPerm, "private"), eq(sql`excluded.read_perm`, "account")),
      ),
    })
    .returning({ name: artifactNames.name })
    .all();
  return claimed.length > 0;
};

// Whether another account already publishes this name for the account to read, read before a byte
// of a publish is streamed. The hostname has no user segment, so two account-readable artifacts
// under one name would be two artifacts at one address; the claim refuses the second outright
// rather than resolving it by an arbitrary tie-break.
export const accountReadableElsewhere = async (db: AccountDb, userId: string, name: string): Promise<boolean> => {
  const route = await artifactRoute(db, name);
  return route !== null && route.readPerm === "account" && route.userId !== userId;
};

// One account's own object reading its own rows, for the pages that object draws itself. A user
// id that is not this object's matches nothing here, which is the split rather than a check.
export const artifactReadsOf = (db: TenantDb): ArtifactReads => ({
  artifact: (userId, name) => getArtifact(db, userId, name),
  artifactPage: (userId, input, cursor) => listArtifactPage(db, userId, input, cursor),
  artifactMatches: (userId, type, match, limit) => searchArtifacts(db, userId, type, match, limit),
  artifactTally: (userId) => artifactCounts(db, userId),
});

// Which artifact a name on the artifact hostname means. The reader's own comes first and is
// served whatever its read permission says. Otherwise one read of the account store says which
// account claims the name, and that account's own object is asked for it; a name nothing claims,
// one claimed privately, and one whose owner no longer publishes it for the account to read are
// all the caller's 404.
export const resolveArtifact = async (
  account: AccountDb,
  store: ArtifactReads,
  readerUserId: string,
  name: string,
): Promise<ArtifactRecord | null> => {
  const own = await store.artifact(readerUserId, name);
  if (own !== null) return own;
  const route = await artifactRoute(account, name);
  if (route === null || route.userId === readerUserId || route.readPerm !== "account") return null;
  const shared = await store.artifact(route.userId, name);
  return shared !== null && shared.read === "account" ? shared : null;
};

interface ShareRow {
  shareId: string;
  userId: string;
  name: string;
  mode: ShareMode;
  subject: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
  uses: number;
}

const SHARE_FIELDS = {
  shareId: artifactShares.shareId,
  userId: artifactShares.userId,
  name: artifactShares.name,
  mode: artifactShares.mode,
  subject: artifactShares.subject,
  createdAt: artifactShares.createdAt,
  expiresAt: artifactShares.expiresAt,
  lastUsedAt: artifactShares.lastUsedAt,
  uses: artifactShares.uses,
};

const toShare = (row: ShareRow): ShareRecord => ({
  shareId: row.shareId,
  userId: row.userId,
  name: row.name,
  mode: row.mode,
  subject: row.subject,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt,
  uses: row.uses,
});

// What one create or one replacement writes. The expiry is the caller's, so the window the share
// opens is named in one place rather than once per statement here.
export interface ShareInput {
  shareId: string;
  userId: string;
  name: string;
  subject: string;
  at: number;
  expiresAt: number;
}

// The two reads that resolve a credential, and the only two that do not filter on the expiry: a
// read of a share's own address is what finds it dead and deletes it, so the row has to come back
// before the window is compared. Both are one read by a unique key, which is what keeps a guess at
// an unauthenticated address to one read and no write.
export const shareByToken = async (db: AccountDb, hash: string): Promise<ShareRecord | null> => {
  const row = await db
    .select(SHARE_FIELDS)
    .from(artifactShares)
    .where(and(eq(artifactShares.mode, "link"), eq(artifactShares.subject, hash)))
    .get();
  return row === undefined ? null : toShare(row);
};

export const shareById = async (db: AccountDb, shareId: string): Promise<ShareRecord | null> => {
  const row = await db
    .select(SHARE_FIELDS)
    .from(artifactShares)
    .where(and(eq(artifactShares.shareId, shareId), eq(artifactShares.mode, "email")))
    .get();
  return row === undefined ? null : toShare(row);
};

// One artifact's live shares, link row first. `'link'` sorts after `'email'`, so the descending
// mode puts it there and artifact_shares_by_artifact supplies the order; nothing is sorted here.
export const artifactShareList = async (
  db: AccountDb,
  userId: string,
  name: string,
  now: number,
): Promise<ShareRecord[]> => {
  const results = await db
    .select(SHARE_FIELDS)
    .from(artifactShares)
    .where(and(eq(artifactShares.userId, userId), eq(artifactShares.name, name), gt(artifactShares.expiresAt, now)))
    .orderBy(desc(artifactShares.mode), asc(artifactShares.createdAt))
    .all();
  return results.map(toShare);
};

// The live shares of the artifacts on one page of a listing, grouped rather than read per row.
// The names go in as one JSON parameter: SQLite binds at most a hundred per statement, and a page
// of a hundred rows plus the account and the clock is two over.
export const sharesFor = async (
  db: AccountDb,
  userId: string,
  names: readonly string[],
  now: number,
): Promise<Map<string, ShareRecord[]>> => {
  const held = new Map<string, ShareRecord[]>();
  if (names.length === 0) return held;
  const results = await db
    .select(SHARE_FIELDS)
    .from(artifactShares)
    .where(
      and(
        eq(artifactShares.userId, userId),
        gt(artifactShares.expiresAt, now),
        sql`${artifactShares.name} IN ${jsonEach(names)}`,
      ),
    )
    .orderBy(asc(artifactShares.name), desc(artifactShares.mode), asc(artifactShares.createdAt))
    .all();
  for (const row of results) {
    const share = toShare(row);
    const already = held.get(share.name);
    if (already === undefined) held.set(share.name, [share]);
    else already.push(share);
  }
  return held;
};

// The same read with the counts returned instead of the rows, which is what the Artifacts tab's
// third read costs and what the owner's bar prints.
export const shareCountsFor = async (
  db: AccountDb,
  userId: string,
  names: readonly string[],
  now: number,
): Promise<Map<string, number>> => {
  if (names.length === 0) return new Map();
  const results = await db
    .select({ name: artifactShares.name, n: count() })
    .from(artifactShares)
    .where(
      and(
        eq(artifactShares.userId, userId),
        gt(artifactShares.expiresAt, now),
        sql`${artifactShares.name} IN ${jsonEach(names)}`,
      ),
    )
    .groupBy(artifactShares.name)
    .all();
  return new Map(results.map((row) => [row.name, row.n]));
};

export const shareCount = async (db: AccountDb, userId: string, name: string, now: number): Promise<number> => {
  const row = await db
    .select({ n: count() })
    .from(artifactShares)
    .where(and(eq(artifactShares.userId, userId), eq(artifactShares.name, name), gt(artifactShares.expiresAt, now)))
    .get();
  return row?.n ?? 0;
};

// The one write a page view under a share prefix costs. A file read and the player's script cost
// none, so a reader seeking through a track does not write a row per range request.
export const recordShareUse = async (db: AccountDb, shareId: string, at: number): Promise<void> => {
  await db
    .update(artifactShares)
    .set({ uses: sql`${artifactShares.uses} + 1`, lastUsedAt: at })
    .where(eq(artifactShares.shareId, shareId))
    .run();
};

// The row a read of its own address found past its expiry, named by its primary key. It is the
// request the reader made that deletes it, and the window is compared again in the statement so a
// renewal that landed in between is not thrown away.
export const deleteExpiredShare = async (db: AccountDb, shareId: string, at: number): Promise<void> => {
  await db
    .delete(artifactShares)
    .where(and(eq(artifactShares.shareId, shareId), lte(artifactShares.expiresAt, at)))
    .run();
};

// A dead share for the address about to be shared again, named by its full key. Without it the
// upsert below would revive the dead row and carry its use count into the new share.
export const deleteDeadEmailShare = async (
  db: AccountDb,
  userId: string,
  name: string,
  address: string,
  at: number,
): Promise<void> => {
  await db
    .delete(artifactShares)
    .where(
      and(
        eq(artifactShares.userId, userId),
        eq(artifactShares.name, name),
        eq(artifactShares.mode, "email"),
        eq(artifactShares.subject, address),
        lte(artifactShares.expiresAt, at),
      ),
    )
    .run();
};

// One statement for a first share and a renewal both: the returned id differing from the one
// generated is what says the address already held a live share and its expiry moved instead.
export const createEmailShare = async (
  db: AccountDb,
  input: ShareInput,
): Promise<{ share: ShareRecord; renewed: boolean }> => {
  const row = await db
    .insert(artifactShares)
    .values({
      shareId: input.shareId,
      userId: input.userId,
      name: input.name,
      mode: "email",
      subject: input.subject,
      createdAt: input.at,
      expiresAt: input.expiresAt,
      lastUsedAt: input.at,
      uses: 0,
    })
    .onConflictDoUpdate({
      target: [artifactShares.userId, artifactShares.name, artifactShares.mode, artifactShares.subject],
      set: { expiresAt: sql`excluded.expires_at` },
    })
    .returning(SHARE_FIELDS)
    .get();
  if (row === undefined) throw new Error(`sharing ${input.name} with an address wrote no row`);
  return { share: toShare(row), renewed: row.shareId !== input.shareId };
};

const linkUpsert = (db: AccountDb, input: ShareInput, setWhere: SQL | undefined) =>
  db
    .insert(artifactShares)
    .values({
      shareId: input.shareId,
      userId: input.userId,
      name: input.name,
      mode: "link",
      subject: input.subject,
      createdAt: input.at,
      expiresAt: input.expiresAt,
      lastUsedAt: input.at,
      uses: 0,
    })
    .onConflictDoUpdate({
      target: [artifactShares.userId, artifactShares.name],
      // The predicate is written out rather than bound, because SQLite matches a conflict target
      // against the partial index's own text and a parameter matches nothing.
      targetWhere: sql`${sql.identifier(artifactShares.mode.name)} = 'link'`,
      set: {
        shareId: sql`excluded.share_id`,
        subject: sql`excluded.subject`,
        createdAt: sql`excluded.created_at`,
        expiresAt: sql`excluded.expires_at`,
        lastUsedAt: sql`excluded.last_used_at`,
        uses: 0,
      },
      setWhere,
    })
    .returning(SHARE_FIELDS);

// The first link share on an artifact. artifact_shares_one_link is what makes a second one
// impossible even under a race: a live row refuses the update and no row comes back, which is the
// answer that asks the owner whether to replace the address already in use. A dead row is
// overwritten, because it opens nothing.
export const createLinkShare = async (db: AccountDb, input: ShareInput): Promise<ShareRecord | null> => {
  const row = await linkUpsert(db, input, sql`${artifactShares.expiresAt} <= excluded.created_at`).get();
  return row === undefined ? null : toShare(row);
};

// The replacement the owner asked for. It retires the old token the moment the new hash lands,
// because one row holds both and the hash is the credential.
export const replaceLinkShare = async (db: AccountDb, input: ShareInput): Promise<ShareRecord> => {
  const row = await linkUpsert(db, input, undefined).get();
  if (row === undefined) throw new Error(`replacing the link share on ${input.name} wrote no row`);
  return toShare(row);
};

// The window moved forward on a live link share. A row that is already gone changes nothing and
// answers null, which the page draws as the share having been revoked by another request.
export const extendLinkShare = async (
  db: AccountDb,
  userId: string,
  name: string,
  now: number,
  expiresAt: number,
): Promise<ShareRecord | null> => {
  const row = await db
    .update(artifactShares)
    .set({ expiresAt })
    .where(
      and(
        eq(artifactShares.userId, userId),
        eq(artifactShares.name, name),
        eq(artifactShares.mode, "link"),
        gt(artifactShares.expiresAt, now),
      ),
    )
    .returning(SHARE_FIELDS)
    .get();
  return row === undefined ? null : toShare(row);
};

// What a revoke names. Every member is scoped to the owner and the artifact, so a share id from
// another artifact deletes nothing even where a caller names one.
export type RevokeScope =
  | { kind: "one"; shareId: string }
  | { kind: "link" }
  | { kind: "email"; address: string }
  | { kind: "all" };

const revokeFilter = (scope: RevokeScope): SQL | undefined => {
  if (scope.kind === "one") return eq(artifactShares.shareId, scope.shareId);
  if (scope.kind === "link") return eq(artifactShares.mode, "link");
  if (scope.kind === "email") {
    return and(eq(artifactShares.mode, "email"), eq(artifactShares.subject, scope.address));
  }
  return undefined;
};

export const revokeShares = async (
  db: AccountDb,
  userId: string,
  name: string,
  scope: RevokeScope,
): Promise<number> => {
  const revoked = await db
    .delete(artifactShares)
    .where(and(eq(artifactShares.userId, userId), eq(artifactShares.name, name), revokeFilter(scope)))
    .returning({ shareId: artifactShares.shareId })
    .all();
  return revoked.length;
};

// Which account an Access service token acts for. A deployment adds a tenant to the connector by
// writing this row, not by editing the Worker's env and deploying again.
export const userForServiceClient = async (db: AccountDb, clientId: string): Promise<string | null> => {
  const row = await db
    .select({ userId: mcpClients.userId })
    .from(mcpClients)
    .where(eq(mcpClients.clientId, clientId))
    .get();
  return row?.userId ?? null;
};

const LEGACY_PAGE = 1_000;

// The artifacts published before a row carried their type. The operator runs it once per
// deployment: a migration cannot read the bucket and nothing may scan on a schedule, so this is
// the one listing of a user's prefix in the feature and it is a request that asks for it.
//
// The delimiter leaves out everything under the container layout, so only the bare keys answer and
// a row that already exists is left exactly as it is.
export const adoptArtifacts = async (db: TenantDb, bucket: R2Bucket, userId: string): Promise<number> => {
  const prefix = `${userId}/`;
  const legacy: R2Object[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, delimiter: "/", cursor, limit: LEGACY_PAGE });
    legacy.push(...page.objects);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  const known = new Set(
    db
      .select({ name: artifacts.name })
      .from(artifacts)
      .where(eq(artifacts.userId, userId))
      .all()
      .map((row) => row.name),
  );
  const taking = legacy.filter((object) => !known.has(object.key.slice(prefix.length)));
  if (taking.length === 0) return 0;
  // One statement per object, never one insert of many rows, for the hundred-parameter ceiling.
  db.transaction((tx) => {
    for (const object of taking) {
      const name = object.key.slice(prefix.length);
      const files: ArtifactFile[] = [{ path: name, bytes: object.size, contentType: contentTypeFor(name) }];
      tx.insert(artifacts)
        .values({
          userId,
          name,
          rev: 0,
          type: "site",
          title: name,
          description: "",
          readPerm: "private",
          writePerm: "owner",
          entryPath: name,
          files: JSON.stringify(files),
          fileCount: 1,
          bytes: object.size,
          createdAt: object.uploaded.getTime(),
          updatedAt: object.uploaded.getTime(),
          lastWriter: "",
        })
        .onConflictDoNothing({ target: [artifacts.userId, artifacts.name] })
        .run();
    }
  });
  return taking.length;
};

export const recall = async (db: TenantDb, userId: string, memoryIds: string[], now: number): Promise<Memory[]> => {
  const named = sql`${memories.memoryId} IN ${jsonEach(memoryIds)}`;
  return db
    .transaction((tx) => {
      tx.update(memories)
        .set({ recallCount: sql`${memories.recallCount} + 1`, lastRecalledAt: now })
        .where(and(eq(memories.userId, userId), named))
        .run();
      return tx
        .select(MEMORY_FIELDS)
        .from(memories)
        .where(and(eq(memories.userId, userId), named))
        .all();
    })
    .map(toMemory);
};

interface BoardRow {
  message_id: string;
  scope: BoardScope;
  target: string;
  from_device_id: string;
  from_host: string;
  from_name: string;
  body: string;
  created_at: number;
  expires_at: number;
}

const toBoardMessage = (row: BoardRow): BoardMessage => ({
  messageId: row.message_id,
  scope: row.scope,
  target: row.target,
  fromDeviceId: row.from_device_id,
  fromHost: row.from_host,
  fromName: row.from_name,
  body: row.body,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

// What has fallen out of the window, taken out where the board is posted to rather than on a
// schedule: nothing in this service makes a pass of its own. A read sweeps nothing, because every
// read already filters on the window and would be spending writes on rows it is ignoring anyway.
// The pickups go first, because a row there outliving its message would read as a message nobody
// can see having been taken.
const sweepBoard = (tx: TenantTx, userId: string, now: number): void => {
  tx.delete(boardPickups)
    .where(
      and(
        eq(boardPickups.userId, userId),
        inArray(
          boardPickups.messageId,
          tx
            .select({ messageId: boardMessages.messageId })
            .from(boardMessages)
            .where(and(eq(boardMessages.userId, userId), lte(boardMessages.expiresAt, now))),
        ),
      ),
    )
    .run();
  tx.delete(boardMessages)
    .where(and(eq(boardMessages.userId, userId), lte(boardMessages.expiresAt, now)))
    .run();
};

export const postBoardMessage = async (db: TenantDb, input: BoardInput): Promise<BoardMessage> => {
  const expiresAt = input.createdAt + BOARD_WINDOW_MS;
  db.transaction((tx) => {
    sweepBoard(tx, input.userId, input.createdAt);
    tx.insert(boardMessages)
      .values({
        userId: input.userId,
        messageId: input.messageId,
        scope: input.address.scope,
        target: input.address.target,
        fromDeviceId: input.fromDeviceId,
        fromHost: input.fromHost,
        fromName: input.fromName,
        body: input.body,
        createdAt: input.createdAt,
        expiresAt,
      })
      .run();
  });
  return {
    messageId: input.messageId,
    scope: input.address.scope,
    target: input.address.target,
    fromDeviceId: input.fromDeviceId,
    fromHost: input.fromHost,
    fromName: input.fromName,
    body: input.body,
    createdAt: input.createdAt,
    expiresAt,
  };
};

// How far down the oldest-first walk a pickup reaches: the running total of the bodies through each
// message, which the budget then cuts. One message always fits, because a post over the same
// ceiling is refused. A window function is not a shape drizzle's select builder can take.
const BOARD_THROUGH = sql`SUM(LENGTH(CAST(${boardMessages.body} AS BLOB)))
  OVER (ORDER BY ${boardMessages.createdAt}, ${boardMessages.messageId} ROWS UNBOUNDED PRECEDING) AS through`;

// The messages one session takes off the board, and takes for good: the claim is an insert against
// a primary key that is the message, so two sessions booting together both run it and only one
// writes a row. Writing the claim from the board itself is what keeps a pickup row from outliving
// the message it acknowledges, and the read that follows it in the same batch is handed what this
// session holds, which is what makes a fleet message run once instead of once per session.
//
// A session reads its own pickups again, because the start hook that takes them can be killed by
// its own timeout after the claim has been written. `SessionStart` fires again on resume and on
// compact under the same session id, so the message comes back to the one session that took it
// rather than being lost to the fleet.
//
// A session-addressed message is only ever picked up from the device that session runs on, so a
// caller naming a session id it does not hold is handed nothing. The device is checked inside the
// walk rather than ahead of it because `sessions --sync` is detached and races the pickup: a
// session not on record yet leaves its message waiting instead of having it refused.
export const claimBoardMessages = async (
  db: TenantDb,
  userId: string,
  taker: BoardTaker,
  now: number,
): Promise<BoardMessage[]> =>
  db
    .transaction((tx) => {
      tx.insert(boardPickups)
        .select(
          sql`SELECT ${userId}, message_id, ${taker.sessionId}, ${taker.deviceId}, ${taker.host},
            ${taker.pickedUpAt} FROM
            (SELECT ${boardMessages.messageId}, ${BOARD_THROUGH}
             FROM ${boardMessages}
             WHERE ${boardMessages.userId} = ${userId} AND ${boardMessages.expiresAt} > ${now}
               AND ((${boardMessages.scope} = 'fleet' AND ${boardMessages.target} = ${userId})
                 OR (${boardMessages.scope} = 'host' AND ${boardMessages.target} = ${taker.deviceId})
                 OR (${boardMessages.scope} = 'session' AND ${boardMessages.target} = ${taker.sessionId}
                   AND EXISTS (SELECT 1 FROM ${sessions}
                     WHERE ${sessions.userId} = ${boardMessages.userId}
                       AND ${sessions.sessionId} = ${boardMessages.target}
                       AND ${sessions.deviceId} = ${taker.deviceId})))
               AND NOT EXISTS (SELECT 1 FROM ${boardPickups}
                 WHERE ${boardPickups.userId} = ${boardMessages.userId}
                   AND ${boardPickups.messageId} = ${boardMessages.messageId}
                   AND (${boardPickups.sessionId} <> ${taker.sessionId}
                     OR ${boardPickups.deviceId} <> ${taker.deviceId})))
          WHERE through <= ${MAX_PICKUP_BYTES}`,
        )
        .onConflictDoNothing({ target: [boardPickups.userId, boardPickups.messageId] })
        .run();
      return tx.all<BoardRow>(sql`
        SELECT * FROM
          (SELECT ${boardMessages.messageId}, ${boardMessages.scope}, ${boardMessages.target},
             ${boardMessages.fromDeviceId}, ${boardMessages.fromHost}, ${boardMessages.fromName},
             ${boardMessages.body}, ${boardMessages.createdAt}, ${boardMessages.expiresAt}, ${BOARD_THROUGH}
           FROM ${boardMessages}
           JOIN ${boardPickups} ON ${boardPickups.userId} = ${boardMessages.userId}
             AND ${boardPickups.messageId} = ${boardMessages.messageId}
           WHERE ${boardMessages.userId} = ${userId} AND ${boardMessages.expiresAt} > ${now}
             AND ${boardPickups.sessionId} = ${taker.sessionId} AND ${boardPickups.deviceId} = ${taker.deviceId})
        WHERE through <= ${MAX_PICKUP_BYTES}
        ORDER BY created_at, message_id`);
    })
    .map(toBoardMessage);

export const listBoard = async (
  db: TenantDb,
  userId: string,
  limit: number,
  [cursorAt, cursorId]: Cursor,
  now: number,
): Promise<{ entries: BoardEntry[]; nextCursor: string }> => {
  const results = db
    .select({
      messageId: boardMessages.messageId,
      scope: boardMessages.scope,
      target: boardMessages.target,
      fromDeviceId: boardMessages.fromDeviceId,
      fromHost: boardMessages.fromHost,
      fromName: boardMessages.fromName,
      body: boardMessages.body,
      createdAt: boardMessages.createdAt,
      expiresAt: boardMessages.expiresAt,
      takerSessionId: boardPickups.sessionId,
      takerDeviceId: boardPickups.deviceId,
      takerHost: boardPickups.host,
      pickedUpAt: boardPickups.pickedUpAt,
    })
    .from(boardMessages)
    .leftJoin(
      boardPickups,
      and(eq(boardPickups.userId, boardMessages.userId), eq(boardPickups.messageId, boardMessages.messageId)),
    )
    .where(
      and(
        eq(boardMessages.userId, userId),
        gt(boardMessages.expiresAt, now),
        sql`(${boardMessages.createdAt} < ${cursorAt}
          OR (${boardMessages.createdAt} = ${cursorAt} AND ${boardMessages.messageId} < ${cursorId}))`,
      ),
    )
    .orderBy(desc(boardMessages.createdAt), desc(boardMessages.messageId))
    .limit(limit + 1)
    .all();
  const entries = results.slice(0, limit).map((row): BoardEntry => {
    const message: BoardMessage = {
      messageId: row.messageId,
      scope: row.scope,
      target: row.target,
      fromDeviceId: row.fromDeviceId,
      fromHost: row.fromHost,
      fromName: row.fromName,
      body: row.body,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
    if (row.pickedUpAt === null) return { state: "waiting", message };
    return {
      state: "taken",
      message,
      takenBy: {
        sessionId: row.takerSessionId ?? "",
        deviceId: row.takerDeviceId ?? "",
        host: row.takerHost ?? "",
        pickedUpAt: row.pickedUpAt,
      },
    };
  });
  const last = entries.at(-1);
  const nextCursor = results.length > limit && last ? encodeCursor(last.message.createdAt, last.message.messageId) : "";
  return { entries, nextCursor };
};

// Where the record path has reached in one file of one session, which is the ordinal the next
// record carries. It is the mark the endpoint weighs an append against; the objects are the
// arbiter and are read only where the two disagree.
export const recordReach = async (db: TenantDb, userId: string, sessionId: string, file: string): Promise<number> => {
  const row = db
    .select({ nextOrdinal: sessionRecords.nextOrdinal })
    .from(sessionRecords)
    .where(
      and(eq(sessionRecords.userId, userId), eq(sessionRecords.sessionId, sessionId), eq(sessionRecords.file, file)),
    )
    .get();
  return row === undefined ? 0 : row.nextOrdinal;
};

// Whether a session's own transcript is on the record mark. A session with a row for `main` indexes
// itself in the request that appends to it, so the consumer the byte path's storage event wakes
// leaves it alone rather than indexing the same prose a second time. The mark is read for `main`
// alone: a delegated file derives nothing either way, and a row for one of those would otherwise
// stop the byte path from ever indexing the session's own prose.
export const onRecordMark = async (db: TenantDb, userId: string, sessionId: string): Promise<boolean> =>
  db
    .select({ file: sessionRecords.file })
    .from(sessionRecords)
    .where(
      and(
        eq(sessionRecords.userId, userId),
        eq(sessionRecords.sessionId, sessionId),
        eq(sessionRecords.file, MAIN_FILE),
      ),
    )
    .get() !== undefined;

export const openChunks = async (
  db: TenantDb,
  userId: string,
  sessionId: string,
  file: string,
): Promise<OpenChunk[]> => {
  const results = db
    .select({ speaker: sessionOpenChunks.speaker, pieces: sessionOpenChunks.pieces, at: sessionOpenChunks.at })
    .from(sessionOpenChunks)
    .where(
      and(
        eq(sessionOpenChunks.userId, userId),
        eq(sessionOpenChunks.sessionId, sessionId),
        eq(sessionOpenChunks.file, file),
      ),
    )
    .all();
  return results.map((row) => {
    const held: unknown = JSON.parse(row.pieces);
    if (!Array.isArray(held) || held.some((piece) => typeof piece !== "string")) {
      throw new Error(`the open chunk of ${file} in session ${sessionId} holds no pieces`);
    }
    return { speaker: row.speaker, pieces: held as string[], at: row.at };
  });
};

// How many chunks a session already holds, which is the ordinal the next one takes. The record
// path shares the counter with the byte path, so a session that was indexed either way appends to
// what is there rather than writing over it.
export const chunkReach = async (db: TenantDb, userId: string, sessionId: string): Promise<number> => {
  const row = db
    .select({ chunks: sessionIndex.chunks })
    .from(sessionIndex)
    .where(and(eq(sessionIndex.userId, userId), eq(sessionIndex.sessionId, sessionId)))
    .get();
  return row === undefined ? 0 : row.chunks;
};

// The counter moved on, which only ever climbs: two paths index one session and a reach that went
// backwards would have the next pass write over prose that is already indexed. The row is opened
// at nothing but the reach where the session has none, since the mark the byte path reads is the
// archive's and not this.
//
// `guard` is what the write is weighed against — the mark a record append read, `undefined` where
// there is nothing to lose the row to.
export const raiseChunkReach = (tx: TenantTx, userId: string, sessionId: string, chunks: number, guard?: SQL): void => {
  const row = sql`SELECT ${userId}, ${sessionId}, 0, 0, ${chunks}`;
  tx.insert(sessionIndex)
    .select(guard === undefined ? row : sql`${row} WHERE ${guard}`)
    .onConflictDoUpdate({
      target: [sessionIndex.userId, sessionIndex.sessionId],
      set: { chunks: sql`MAX(session_index.chunks, excluded.chunks)` },
    })
    .run();
};

export interface RecordCommit {
  userId: string;
  sessionId: string;
  file: string;
  /// The mark the appending request read before it did any work. Everything below lands only
  /// while the mark still stands there, which is what makes one append of a file at a time.
  held: number;
  next: number;
  chunkFrom: number;
  chunks: IndexedChunk[];
  open: readonly OpenChunk[];
  /// Whether this append takes a session the byte path wrote over from it. A replay opens at
  /// ordinal 0 and carries the whole file after it, so what the byte path indexed is prose these
  /// records index again: its mark and its chunks go in the batch below, in front of the chunks
  /// that replace them.
  takeover: boolean;
}

// The mark the append was weighed against, still standing. Every statement of the commit carries
// it, so a second append that read the same mark and was beaten to it writes nothing at all rather
// than laying its chunks over the winner's.
const markStands = (commit: RecordCommit): SQL =>
  sql`${commit.held} = COALESCE((SELECT ${sessionRecords.nextOrdinal} FROM ${sessionRecords}
    WHERE ${sessionRecords.userId} = ${commit.userId} AND ${sessionRecords.sessionId} = ${commit.sessionId}
      AND ${sessionRecords.file} = ${commit.file}), 0)`;

// Everything one record append leaves behind, written in one batch: the chunks it closed, the
// chunk counter they take their ordinals from, how far the records of the file now reach, and the
// chunk the batch ran out before closing. They land together because a mark ahead of its chunks
// would have the next append open where this one's prose was never indexed.
//
// It answers whether the mark was still where the request read it. A caller told `false` lost the
// file to another append and nothing it carried was written; ordinals are implicit in position, so
// a host knows its next `from` without asking and pipelines two appends as a matter of course.
//
// Every insert here is guarded by a SELECT, which the insert builder's `values` cannot express, so
// the rows are written out and the builder supplies the column list from the schema.
export const commitRecords = async (db: TenantDb, commit: RecordCommit): Promise<boolean> => {
  const { userId, sessionId, file, chunkFrom, chunks, open, next, takeover } = commit;
  return db.transaction((tx) => {
    // A takeover first, so everything below it is written over a session the byte path no longer
    // holds anything of. The two statements and the mark at the foot of the batch land together,
    // which is what leaves no instant where one session is on both paths.
    if (takeover) {
      tx.run(sql`DELETE FROM ${sessionChunks}
        WHERE ${sessionChunks.userId} = ${userId} AND ${sessionChunks.sessionId} = ${sessionId}
          AND ${markStands(commit)}`);
      tx.insert(sessionIndex)
        .select(sql`SELECT ${userId}, ${sessionId}, 0, 0, 0 WHERE ${markStands(commit)}`)
        .onConflictDoUpdate({
          target: [sessionIndex.userId, sessionIndex.sessionId],
          set: { archived: 0, bytes: 0, chunks: 0 },
        })
        .run();
    }
    chunks.forEach((chunk, index) => {
      tx.insert(sessionChunks)
        .select(
          sql`SELECT NULL, ${userId}, ${sessionId}, ${chunkFrom + index}, ${chunk.speaker}, ${chunk.text},
            ${blobOf(chunk.embedding)}, ${chunk.at}
          WHERE ${markStands(commit)}`,
        )
        .run();
    });
    if (chunks.length > 0) {
      raiseChunkReach(tx, userId, sessionId, chunkFrom + chunks.length, markStands(commit));
    }
    tx.run(sql`DELETE FROM ${sessionOpenChunks}
      WHERE ${sessionOpenChunks.userId} = ${userId} AND ${sessionOpenChunks.sessionId} = ${sessionId}
        AND ${sessionOpenChunks.file} = ${file} AND ${markStands(commit)}`);
    for (const chunk of open) {
      tx.insert(sessionOpenChunks)
        .select(
          sql`SELECT ${userId}, ${sessionId}, ${file}, ${chunk.speaker}, ${JSON.stringify(chunk.pieces)}, ${chunk.at}
          WHERE ${markStands(commit)}`,
        )
        .run();
    }
    const marked = tx
      .insert(sessionRecords)
      .select(sql`SELECT ${userId}, ${sessionId}, ${file}, ${next} WHERE ${markStands(commit)}`)
      .onConflictDoUpdate({
        target: [sessionRecords.userId, sessionRecords.sessionId, sessionRecords.file],
        set: { nextOrdinal: sql`excluded.next_ordinal` },
      })
      .returning({ file: sessionRecords.file })
      .all();
    return marked.length === 1;
  });
};
