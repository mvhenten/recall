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
  type SessionMode,
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
import type { ShareMode, ShareRecord } from "./shares";

interface MemoryRow {
  memory_id: string;
  user_id: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  created_at: number;
  updated_at: number;
  recall_count: number;
  last_recalled_at: number;
  tags_json: string;
}

const MEMORY_COLUMNS = `m.memory_id, m.user_id, m.name, m.description, m.type, m.body, m.created_at, m.updated_at,
  m.recall_count, m.last_recalled_at,
  (SELECT json_group_array(tag) FROM (SELECT tag FROM memory_tags t WHERE t.memory_id = m.memory_id ORDER BY tag)) AS tags_json`;

const TAG_FILTER = `(json_array_length(?2) = 0 OR EXISTS (
  SELECT 1 FROM memory_tags t
  WHERE t.memory_id = m.memory_id AND t.tag IN (SELECT value FROM json_each(?2))))`;

const typeFilter = (slot: number): string =>
  `(json_array_length(?${slot}) = 0 OR m.type IN (SELECT value FROM json_each(?${slot})))`;

const toMemory = (row: MemoryRow): Memory => ({
  memoryId: row.memory_id,
  userId: row.user_id,
  name: row.name,
  description: row.description,
  type: row.type,
  body: row.body,
  tags: JSON.parse(row.tags_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  recallCount: row.recall_count,
  lastRecalledAt: row.last_recalled_at,
});

export const getMemory = async (db: D1Database, userId: string, name: string): Promise<Memory | null> => {
  const row = await db
    .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories m WHERE m.user_id = ? AND m.name = ?`)
    .bind(userId, name)
    .first<MemoryRow>();
  return row ? toMemory(row) : null;
};

export const saveMemory = async (
  db: D1Database,
  userId: string,
  name: string,
  input: SaveInput,
  embedding: Uint8Array,
  now: number,
): Promise<{ memory: Memory; created: boolean }> => {
  const candidateId = crypto.randomUUID();
  const ownedId = "(SELECT memory_id FROM memories WHERE user_id = ? AND name = ?)";
  const [upsert] = await db.batch<{ memory_id: string }>([
    db
      .prepare(
        `INSERT INTO memories (memory_id, user_id, name, description, type, body, embedding, created_at, updated_at, recall_count, last_recalled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
         ON CONFLICT (user_id, name) DO UPDATE SET
           description = excluded.description, type = excluded.type, body = excluded.body,
           embedding = excluded.embedding, updated_at = excluded.updated_at
         RETURNING memory_id`,
      )
      .bind(candidateId, userId, name, input.description, input.type, input.body, embedding.buffer, now, now),
    db.prepare(`DELETE FROM memory_tags WHERE memory_id = ${ownedId}`).bind(userId, name),
    db
      .prepare(
        `INSERT INTO memory_tags (memory_id, tag)
         SELECT ${ownedId}, value FROM json_each(?)`,
      )
      .bind(userId, name, JSON.stringify(input.tags)),
  ]);
  const memory = await getMemory(db, userId, name);
  if (!memory) throw new Error(`memory ${name} vanished right after it was saved`);
  return { memory, created: upsert?.results[0]?.memory_id === candidateId };
};

export const deleteMemory = async (db: D1Database, userId: string, memoryId: string): Promise<void> => {
  await db.prepare("DELETE FROM memories WHERE user_id = ? AND memory_id = ?").bind(userId, memoryId).run();
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

// The empty cursor is page one, which for a descending order is a value no row can be above and
// for an ascending one a value no row can be below. The two-element shape is the one the dashboard
// has always issued, so a bookmarked page link from before this still decodes and pages.
export const decodeCursor = (cursor: string, direction: "desc" | "asc"): Cursor | null => {
  if (cursor === "") return direction === "desc" ? [Number.MAX_SAFE_INTEGER, ""] : ["", ""];
  const parsed = readCursorJson(cursor);
  if (!Array.isArray(parsed) || typeof parsed[1] !== "string") return null;
  const at = parsed[0];
  if (typeof at !== "number" && typeof at !== "string") return null;
  return [at, parsed[1]];
};

// One order of one list: the predicate that walks past the cursor, the clause that names the index
// serving it, which way the cursor runs, and where a row's own cursor comes from. Nothing is
// ordered in the Worker, so a list grows an order by growing this table and nothing else.
interface Order<Row> {
  keyset: string;
  by: string;
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
    keyset: "(m.created_at < ?4 OR (m.created_at = ?4 AND m.memory_id < ?5))",
    by: "m.created_at DESC, m.memory_id DESC",
    direction: "desc",
    cursorOf: (memory) => [memory.createdAt, memory.memoryId],
  },
  name: {
    keyset: "m.name > ?4",
    by: "m.name",
    direction: "asc",
    cursorOf: (memory) => [memory.name, memory.name],
  },
  recalled: {
    keyset: "(m.recall_count < ?4 OR (m.recall_count = ?4 AND m.name > ?5))",
    by: "m.recall_count DESC, m.name",
    direction: "desc",
    cursorOf: (memory) => [memory.recallCount, memory.name],
  },
};

export const memoryCursorDirection = (sort: string): "desc" | "asc" => orderFor(MEMORY_ORDERS, sort).direction;

export const listMemories = async (
  db: D1Database,
  userId: string,
  input: ListInput,
  [cursorAt, cursorId]: Cursor,
): Promise<{ memories: Memory[]; nextCursor: string }> => {
  const order = orderFor(MEMORY_ORDERS, input.sort);
  const { results } = await db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories m
       WHERE m.user_id = ?1 AND ${TAG_FILTER} AND ${typeFilter(7)} AND m.created_at >= ?3
         AND ${order.keyset}
       ORDER BY ${order.by}
       LIMIT ?6`,
    )
    .bind(
      userId,
      JSON.stringify(input.tags),
      input.since,
      cursorAt,
      cursorId,
      input.limit + 1,
      JSON.stringify(input.types),
    )
    .all<MemoryRow>();
  const memories = results.slice(0, input.limit).map(toMemory);
  const last = memories.at(-1);
  const nextCursor = results.length > input.limit && last ? encodeCursor(...order.cursorOf(last)) : "";
  return { memories, nextCursor };
};

export const memoryCounts = async (db: D1Database, userId: string, since: number): Promise<MemoryCounts> => {
  const { results } = await db
    .prepare(
      `SELECT m.type AS type, COUNT(*) AS total,
         SUM(CASE WHEN m.recall_count > 0 THEN 1 ELSE 0 END) AS recalled,
         SUM(CASE WHEN m.created_at >= ?2 THEN 1 ELSE 0 END) AS fresh
       FROM memories m WHERE m.user_id = ?1
       GROUP BY m.type ORDER BY total DESC, m.type`,
    )
    .bind(userId, since)
    .all<{ type: MemoryType; total: number; recalled: number; fresh: number }>();
  const sum = (pick: (row: { total: number; recalled: number; fresh: number }) => number): number =>
    results.reduce((running, row) => running + pick(row), 0);
  return {
    total: sum((row) => row.total),
    recalled: sum((row) => row.recalled),
    fresh: sum((row) => row.fresh),
    byType: results.map((row) => ({ type: row.type, count: row.total })),
  };
};

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error("embedding column is not a blob");
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

export const vectorCandidates = async (
  db: D1Database,
  userId: string,
  tags: string[],
  types: MemoryType[],
): Promise<VectorCandidate[]> => {
  const rows = await db
    .prepare(
      `SELECT m.memory_id, m.embedding, ${TAG_FILTER} AS in_scope FROM memories m
       WHERE m.user_id = ?1 AND ${typeFilter(3)}`,
    )
    .bind(userId, JSON.stringify(tags), JSON.stringify(types))
    .raw<[string, unknown, number]>();
  return rows.map(([memoryId, embedding, inScope]) => ({
    memoryId,
    embedding: toBytes(embedding),
    inScope: inScope === 1,
  }));
};

export const textCandidates = async (
  db: D1Database,
  userId: string,
  tags: string[],
  types: MemoryType[],
  query: string,
): Promise<TextCandidate[]> => {
  const { results } = await db
    .prepare(
      `SELECT m.memory_id, ${TAG_FILTER} AS in_scope FROM memories_fts f JOIN memories m ON m.memory_seq = f.rowid
       WHERE memories_fts MATCH ?3 AND m.user_id = ?1 AND ${typeFilter(4)}
       ORDER BY in_scope DESC, bm25(memories_fts, 5.0, 2.0, 1.0) LIMIT 50`,
    )
    .bind(userId, JSON.stringify(tags), query, JSON.stringify(types))
    .all<{ memory_id: string; in_scope: number }>();
  return results.map((row) => ({ memoryId: row.memory_id, inScope: row.in_scope === 1 }));
};

export const describeMemories = async (db: D1Database, userId: string, memoryIds: string[]): Promise<Memory[]> => {
  const { results } = await db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories m WHERE m.user_id = ? AND m.memory_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(userId, JSON.stringify(memoryIds))
    .all<MemoryRow>();
  return results.map(toMemory);
};

interface SessionRow {
  session_id: string;
  device_name: string;
  agent_name: string;
  device_id: string;
  host: string;
  cwd: string;
  repo: string;
  branch: string;
  commit_subject: string;
  started_at: number;
  last_activity_at: number;
  prompts: number;
  focus_first: string;
  focus_latest: string;
  mode: SessionMode;
  permission_mode: string;
  pid: number;
}

const toSession = (row: SessionRow): Session => ({
  sessionId: row.session_id,
  name: sessionHandle(row.device_name, row.session_id),
  agentName: row.agent_name,
  deviceId: row.device_id,
  host: row.host,
  cwd: row.cwd,
  repo: row.repo,
  branch: row.branch,
  commit: row.commit_subject,
  startedAt: row.started_at,
  lastActivityAt: row.last_activity_at,
  prompts: row.prompts,
  focus: { first: row.focus_first, latest: row.focus_latest },
  mode: row.mode,
  permissionMode: row.permission_mode,
  pid: row.pid,
});

const expireSessions = (db: D1Database, userId: string, now: number): D1PreparedStatement =>
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND last_activity_at <= ?").bind(userId, now - SESSION_TTL_MS);

export const putSession = async (
  db: D1Database,
  caller: Caller,
  sessionId: string,
  input: SessionInput,
  now: number,
): Promise<void> => {
  await db.batch([
    expireSessions(db, caller.userId, now),
    db
      .prepare(
        `INSERT INTO sessions (user_id, session_id, device_id, host, cwd, repo, branch, commit_subject,
           started_at, last_activity_at, prompts, focus_first, focus_latest, mode, permission_mode, pid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT (user_id, session_id) DO UPDATE SET
           device_id = excluded.device_id, host = excluded.host, cwd = excluded.cwd, repo = excluded.repo,
           branch = excluded.branch, commit_subject = excluded.commit_subject, started_at = excluded.started_at,
           last_activity_at = excluded.last_activity_at, prompts = excluded.prompts,
           focus_first = excluded.focus_first, focus_latest = excluded.focus_latest, mode = excluded.mode,
           permission_mode = excluded.permission_mode, pid = excluded.pid`,
      )
      .bind(
        caller.userId,
        sessionId,
        caller.deviceId,
        input.host,
        input.cwd,
        input.repo,
        input.branch,
        input.commit,
        input.startedAt,
        input.lastActivityAt,
        input.prompts,
        input.focus.first,
        input.focus.latest,
        input.mode,
        input.permissionMode,
        input.pid,
      ),
    db
      .prepare(
        `INSERT OR REPLACE INTO session_history (user_id, session_id, device_id, device_name, host, cwd, repo,
           branch, commit_subject, started_at, last_activity_at, prompts, focus_first, focus_latest, mode, agent_name)
         SELECT s.user_id, s.session_id, s.device_id, COALESCE(d.name, ''), s.host, s.cwd, s.repo,
           s.branch, s.commit_subject, s.started_at, s.last_activity_at, s.prompts, s.focus_first, s.focus_latest,
           s.mode, s.agent_name
         FROM sessions s LEFT JOIN devices d ON d.device_id = s.device_id AND d.user_id = s.user_id
         WHERE s.user_id = ?1 AND s.session_id = ?2`,
      )
      .bind(caller.userId, sessionId),
  ]);
};

export const endSession = async (db: D1Database, userId: string, sessionId: string): Promise<boolean> => {
  const result = await db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND session_id = ?")
    .bind(userId, sessionId)
    .run();
  return result.meta.changes === 1;
};

export const listSessions = async (db: D1Database, userId: string, now: number): Promise<Session[]> => {
  const [, listed] = await db.batch<SessionRow>([
    expireSessions(db, userId, now),
    db
      .prepare(
        `SELECT s.session_id, COALESCE(d.name, '') AS device_name, s.agent_name, s.device_id, s.host, s.cwd, s.repo,
           s.branch, s.commit_subject, s.started_at, s.last_activity_at, s.prompts, s.focus_first, s.focus_latest,
           s.mode, s.permission_mode, s.pid
         FROM sessions s LEFT JOIN devices d ON d.device_id = s.device_id AND d.user_id = s.user_id
         WHERE s.user_id = ? ORDER BY s.last_activity_at DESC, s.session_id`,
      )
      .bind(userId),
  ]);
  return (listed?.results ?? []).map(toSession);
};

interface PastSessionRow {
  session_id: string;
  device_name: string;
  agent_name: string;
  host: string;
  cwd: string;
  repo: string;
  branch: string;
  started_at: number;
  last_activity_at: number;
  prompts: number;
  focus_first: string;
  focus_latest: string;
  running: number;
}

const toPastSession = (row: PastSessionRow): PastSession => ({
  sessionId: row.session_id,
  name: sessionHandle(row.device_name, row.session_id),
  agentName: row.agent_name,
  host: row.host,
  cwd: row.cwd,
  repo: row.repo,
  branch: row.branch,
  startedAt: row.started_at,
  lastActivityAt: row.last_activity_at,
  prompts: row.prompts,
  focus: { first: row.focus_first, latest: row.focus_latest },
  running: row.running === 1,
});

// Every session the account has on record, with the one still running marked. `liveSlot` is where
// the caller binds the moment a session counts as gone, so a reader may put its own parameters
// either side of it.
const pastSessions = (liveSlot: number): string =>
  `SELECT h.session_id, h.device_name, h.agent_name, h.host, h.cwd, h.repo, h.branch, h.started_at,
     h.last_activity_at, h.prompts, h.focus_first, h.focus_latest, s.session_id IS NOT NULL AS running
   FROM session_history h
   LEFT JOIN sessions s ON s.user_id = h.user_id AND s.session_id = h.session_id
     AND s.last_activity_at > ?${liveSlot}`;

// session_history_by_activity and session_history_by_agent_name in that order.
const HISTORY_ORDERS: Record<string, Order<PastSession>> = {
  newest: {
    keyset: "(h.last_activity_at < ?4 OR (h.last_activity_at = ?4 AND h.session_id < ?5))",
    by: "h.last_activity_at DESC, h.session_id DESC",
    direction: "desc",
    cursorOf: (session) => [session.lastActivityAt, session.sessionId],
  },
  agent: {
    keyset: "(h.agent_name > ?4 OR (h.agent_name = ?4 AND h.session_id > ?5))",
    by: "h.agent_name, h.session_id",
    direction: "asc",
    cursorOf: (session) => [session.agentName, session.sessionId],
  },
};

export const historyCursorDirection = (sort: string): "desc" | "asc" => orderFor(HISTORY_ORDERS, sort).direction;

export const listSessionHistory = async (
  db: D1Database,
  userId: string,
  input: HistoryInput,
  [cursorAt, cursorSessionId]: Cursor,
  now: number,
): Promise<{ sessions: PastSession[]; nextCursor: string }> => {
  const order = orderFor(HISTORY_ORDERS, input.sort);
  const { results } = await db
    .prepare(
      `${pastSessions(7)}
       WHERE h.user_id = ?1 AND (?2 = '' OR h.host = ?2) AND (?3 = '' OR h.repo = ?3)
         AND ${order.keyset}
       ORDER BY ${order.by}
       LIMIT ?6`,
    )
    .bind(userId, input.host, input.repo, cursorAt, cursorSessionId, input.limit + 1, now - SESSION_TTL_MS)
    .all<PastSessionRow>();
  const sessions = results.slice(0, input.limit).map(toPastSession);
  const last = sessions.at(-1);
  const nextCursor = results.length > input.limit && last ? encodeCursor(...order.cursorOf(last)) : "";
  return { sessions, nextCursor };
};

// History by what a session was about. The index stores its own copy of the focus, the commit
// subject and the agent name, so one match is one read of the history row beside it. A relevance
// order has no keyset, so a search is one bounded page and never carries a cursor.
export const searchSessionHistory = async (
  db: D1Database,
  userId: string,
  input: HistoryInput,
  match: string,
  limit: number,
  now: number,
): Promise<{ sessions: PastSession[]; cut: boolean }> => {
  const { results } = await db
    .prepare(
      `${pastSessions(6)}
       JOIN session_history_fts f ON f.session_id = h.session_id AND f.user_id = h.user_id
       WHERE session_history_fts MATCH ?2 AND h.user_id = ?1
         AND (?3 = '' OR h.host = ?3) AND (?4 = '' OR h.repo = ?4)
       ORDER BY bm25(session_history_fts) LIMIT ?5`,
    )
    .bind(userId, match, input.host, input.repo, limit + 1, now - SESSION_TTL_MS)
    .all<PastSessionRow>();
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
  db: D1Database,
  userId: string,
  cursor: string,
): Promise<{ sessionIds: string[]; nextCursor: string }> => {
  const { results } = await db
    .prepare(
      `SELECT session_id FROM session_history
       WHERE user_id = ?1 AND session_id > ?2
       ORDER BY session_id
       LIMIT ?3`,
    )
    .bind(userId, cursor, SESSION_IDS_PAGE + 1)
    .all<{ session_id: string }>();
  const page = results.slice(0, SESSION_IDS_PAGE);
  const last = page.at(-1);
  return {
    sessionIds: page.map((row) => row.session_id),
    nextCursor: results.length > SESSION_IDS_PAGE && last ? last.session_id : "",
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
  db: D1Database,
  userId: string,
  target: string,
  now: number,
): Promise<FoundSession | null> => {
  const gone = now - SESSION_TTL_MS;
  const named = await db
    .prepare(
      `SELECT found.*, COUNT(*) OVER () AS matches FROM (${pastSessions(3)}
         WHERE h.user_id = ?1 AND (h.session_id = ?2 OR h.agent_name = ?2)) AS found
       ORDER BY found.last_activity_at DESC, found.session_id DESC LIMIT 1`,
    )
    .bind(userId, target, gone)
    .first<PastSessionRow & { matches: number }>();
  if (named !== null) return { session: toPastSession(named), matches: named.matches };
  // A handle is a device name, a dash and the head of a session id, and the device name may hold
  // dashes of its own; the last dash is the one that splits them.
  const dash = target.lastIndexOf("-");
  if (dash <= 0) return null;
  const { results } = await db
    .prepare(
      `${pastSessions(3)}
       WHERE h.user_id = ?1 AND h.device_name = ?2
       ORDER BY h.last_activity_at DESC, h.session_id DESC LIMIT ${HANDLE_SCAN}`,
    )
    .bind(userId, target.slice(0, dash), gone)
    .all<PastSessionRow>();
  const matched = results.filter((found) => sessionHandle(found.device_name, found.session_id) === target);
  const row = matched[0];
  return row ? { session: toPastSession(row), matches: matched.length } : null;
};

export const describeSessions = async (
  db: D1Database,
  userId: string,
  sessionIds: string[],
  now: number,
): Promise<Map<string, PastSession>> => {
  const { results } = await db
    .prepare(`${pastSessions(3)} WHERE h.user_id = ?1 AND h.session_id IN (SELECT value FROM json_each(?2))`)
    .bind(userId, JSON.stringify(sessionIds), now - SESSION_TTL_MS)
    .all<PastSessionRow>();
  return new Map(results.map((row) => [row.session_id, toPastSession(row)]));
};

// The name the harness gave a session, learned from the head of its own transcript. It is written
// to both tables because the two carry a session at different points in its life: a live session
// has a row in each, and one already over has only the history row left.
export const nameSession = async (
  db: D1Database,
  userId: string,
  sessionId: string,
  agentName: string,
): Promise<void> => {
  await db.batch(
    ["sessions", "session_history"].map((table) =>
      db
        .prepare(`UPDATE ${table} SET agent_name = ?3 WHERE user_id = ?1 AND session_id = ?2 AND agent_name = ''`)
        .bind(userId, sessionId, agentName),
    ),
  );
};

export const sessionHistoryFilters = async (db: D1Database, userId: string): Promise<HistoryFilters> => {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT 'host' AS field, host AS value FROM session_history WHERE user_id = ?1 AND host <> ''
       UNION
       SELECT DISTINCT 'repo' AS field, repo AS value FROM session_history WHERE user_id = ?1 AND repo <> ''
       ORDER BY field, value`,
    )
    .bind(userId)
    .all<{ field: string; value: string }>();
  const values = (field: string): string[] => results.filter((row) => row.field === field).map((row) => row.value);
  return { hosts: values("host"), repos: values("repo") };
};

type LabelRow = { kind: LabelKind; value: string; label: string };

export const readLabels = async (db: D1Database, userId: string): Promise<Labels> => {
  const { results } = await db
    .prepare("SELECT kind, value, label FROM labels WHERE user_id = ? ORDER BY kind, value")
    .bind(userId)
    .all<LabelRow>();
  const of = (kind: LabelKind): Map<string, string> =>
    new Map(results.filter((row) => row.kind === kind).map((row) => [row.value, row.label]));
  return { hosts: of("host"), accounts: of("account") };
};

// Every host and account the user has on record, live or past, plus the ones already labelled, so a
// label survives on the page that set it even once its value stops appearing in the data.
export const labelTargets = async (db: D1Database, userId: string): Promise<LabelTargets> => {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT 'host' AS kind, host AS value FROM sessions WHERE user_id = ?1 AND host <> ''
       UNION
       SELECT DISTINCT 'host', host FROM session_history WHERE user_id = ?1 AND host <> ''
       UNION
       SELECT DISTINCT 'host', host FROM usage_daily WHERE user_id = ?1 AND host <> ''
       UNION
       SELECT DISTINCT 'account', account FROM usage_daily WHERE user_id = ?1 AND account <> ''
       UNION
       SELECT DISTINCT kind, value FROM labels WHERE user_id = ?1
       ORDER BY kind, value`,
    )
    .bind(userId)
    .all<{ kind: string; value: string }>();
  const values = (kind: string): string[] => results.filter((row) => row.kind === kind).map((row) => row.value);
  return { hosts: values("host"), accounts: values("account") };
};

export const writeLabels = async (db: D1Database, userId: string, labels: Label[]): Promise<void> => {
  if (labels.length === 0) return;
  await db.batch(
    labels.map((entry) =>
      entry.label === ""
        ? db
            .prepare("DELETE FROM labels WHERE user_id = ?1 AND kind = ?2 AND value = ?3")
            .bind(userId, entry.kind, entry.value)
        : db
            .prepare(
              `INSERT INTO labels (user_id, kind, value, label) VALUES (?1, ?2, ?3, ?4)
               ON CONFLICT (user_id, kind, value) DO UPDATE SET label = excluded.label`,
            )
            .bind(userId, entry.kind, entry.value, entry.label),
    ),
  );
};

type CountRow = {
  prompts: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
};

type ModelRow = CountRow & { provider: string; model: string };
type ModelBucketRow = ModelRow & { bucket: string };
type SplitRow = ModelRow & { field: UsageSplitField; value: string };
type SessionsRow = { day: string; sessions: number };
type LiveRow = { sessions: number; busy: number; sessions_today: number };
type RecallRow = { name: string; recall_count: number; total_recalls: number };
type StaleRow = {
  name: string;
  recall_count: number;
  last_recalled_at: number;
  created_at: number;
  at_risk: number;
};
type RepoRow = { repo: string; ms: number; sessions: number };
type RhythmRow = { weekday: number; hour: number; sessions: number };
type MemoryTotalRow = { memories: number };

// D1 types a batch by one row shape, but the statements in a batch need not share one. This names
// the shape of a single result set — the same unchecked assertion .all<Row>() makes for a lone
// statement — so one page costs one round trip instead of one per read.
const resultRows = <Row extends Record<string, unknown>>(
  result: D1Result<Record<string, unknown>> | undefined,
): Row[] => (result?.results ?? []) as Row[];

const COUNT_SUMS = `COALESCE(SUM(prompts), 0) AS prompts,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens`;

const toCounts = (row: CountRow): TokenCounts => ({
  prompts: row.prompts,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheWriteTokens: row.cache_write_tokens,
  cacheReadTokens: row.cache_read_tokens,
});

const toModelTotals = (row: ModelRow): ModelTotals => ({
  provider: row.provider,
  model: row.model,
  ...toCounts(row),
});

// Every window the pages draw reads the daily rollup and nothing else: the counters land in
// usage_daily on the same write that records the raw event, so the current day is already live
// there and no window ever touches usage_events.
const usageDaysStatement = (db: D1Database, userId: string, fromDay: string): D1PreparedStatement =>
  db
    .prepare(
      `SELECT day AS bucket, provider, model, ${COUNT_SUMS} FROM usage_daily
       WHERE user_id = ?1 AND day >= ?2
       GROUP BY bucket, provider, model ORDER BY bucket, provider, model`,
    )
    .bind(userId, fromDay);

// The month a delta falls in is the month of the UTC day the rollup already keyed it under, so the
// long horizon reads the same column the windows do and the two can never disagree.
const usageMonthsStatement = (db: D1Database, userId: string): D1PreparedStatement =>
  db
    .prepare(
      `SELECT substr(day, 1, 7) AS bucket, provider, model, ${COUNT_SUMS} FROM usage_daily
       WHERE user_id = ?1
       GROUP BY bucket, provider, model ORDER BY bucket, provider, model`,
    )
    .bind(userId);

const usageSplitsStatement = (db: D1Database, userId: string, fromDay: string): D1PreparedStatement =>
  db
    .prepare(
      `SELECT 'host' AS field, host AS value, provider, model, ${COUNT_SUMS} FROM usage_daily
         WHERE user_id = ?1 AND day >= ?2 GROUP BY host, provider, model
       UNION ALL
       SELECT 'repo' AS field, repo AS value, provider, model, ${COUNT_SUMS} FROM usage_daily
         WHERE user_id = ?1 AND day >= ?2 GROUP BY repo, provider, model
       UNION ALL
       SELECT 'account' AS field, account AS value, provider, model, ${COUNT_SUMS} FROM usage_daily
         WHERE user_id = ?1 AND day >= ?2 GROUP BY account, provider, model`,
    )
    .bind(userId, fromDay);

const sessionsPerDayStatement = (db: D1Database, userId: string, since: number): D1PreparedStatement =>
  db
    .prepare(
      `SELECT date(started_at / 1000, 'unixepoch') AS day, COUNT(*) AS sessions
       FROM session_history WHERE user_id = ? AND started_at >= ?
       GROUP BY day ORDER BY day`,
    )
    .bind(userId, since);

// A session that opened before the window or runs past its end only lends the stretch that falls
// inside it, so a months-old session touching a repo yesterday cannot donate its whole life to the
// fortnight. Overlapping sessions still each count their own stretch: this is session time, not
// wall-clock time, and the page says so. The all-time ranking passes since 0, which leaves the clip
// at now and nothing else.
const repoHoursStatement = (
  db: D1Database,
  userId: string,
  since: number,
  until: number,
  limit: number,
): D1PreparedStatement =>
  db
    .prepare(
      `SELECT repo, SUM(MAX(MIN(last_activity_at, ?3) - MAX(started_at, ?2), 0)) AS ms, COUNT(*) AS sessions
       FROM session_history
       WHERE user_id = ?1 AND last_activity_at >= ?2 AND started_at <= ?3
       GROUP BY repo ORDER BY ms DESC, repo LIMIT ?4`,
    )
    .bind(userId, since, until, limit);

const rhythmStatement = (db: D1Database, userId: string, since: number): D1PreparedStatement =>
  db
    .prepare(
      `SELECT CAST(strftime('%w', started_at / 1000, 'unixepoch') AS INTEGER) AS weekday,
         CAST(strftime('%H', started_at / 1000, 'unixepoch') AS INTEGER) AS hour,
         COUNT(*) AS sessions
       FROM session_history WHERE user_id = ? AND started_at >= ?
       GROUP BY weekday, hour ORDER BY sessions DESC, weekday, hour`,
    )
    .bind(userId, since);

const workingSetStatement = (db: D1Database, userId: string, since: number, limit: number): D1PreparedStatement =>
  db
    .prepare(
      `SELECT name, recall_count, SUM(recall_count) OVER () AS total_recalls
       FROM memories WHERE user_id = ?1 AND recall_count > 0 AND last_recalled_at >= ?2
       ORDER BY recall_count DESC, name LIMIT ?3`,
    )
    .bind(userId, since, limit);

const staleStatement = (
  db: D1Database,
  userId: string,
  staleBefore: number,
  savedBefore: number,
  limit: number,
): D1PreparedStatement =>
  db
    .prepare(
      `SELECT name, recall_count, last_recalled_at, created_at, COUNT(*) OVER () AS at_risk
       FROM memories WHERE user_id = ?1
         AND ((recall_count > 0 AND last_recalled_at < ?2) OR (recall_count = 0 AND created_at < ?3))
       ORDER BY (CASE WHEN recall_count = 0 THEN created_at ELSE last_recalled_at END), name
       LIMIT ?4`,
    )
    .bind(userId, staleBefore, savedBefore, limit);

const WORKING_SET_SIZE = 5;
const STALE_LIST_SIZE = 5;
const REPO_BAR_COUNT = 5;

// The sidebar's live summary, on every dashboard page: one round trip for the expiry sweep, the
// live and busy counts, today's sessions and today's tokens, which the page prices on render.
export const liveTally = async (db: D1Database, userId: string, now: number): Promise<Live> => {
  const [, counts, today] = await db.batch<Record<string, unknown>>([
    expireSessions(db, userId, now),
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions WHERE user_id = ?1 AND last_activity_at > ?3) AS sessions,
           (SELECT COALESCE(SUM(last_activity_at > ?2), 0) FROM sessions
              WHERE user_id = ?1 AND last_activity_at > ?3) AS busy,
           (SELECT COUNT(*) FROM session_history WHERE user_id = ?1 AND started_at >= ?4) AS sessions_today`,
      )
      .bind(userId, now - IDLE_AFTER_MS, now - SESSION_TTL_MS, usageDayStart(now)),
    db
      .prepare(
        `SELECT provider, model, ${COUNT_SUMS} FROM usage_daily
         WHERE user_id = ?1 AND day = ?2 GROUP BY provider, model`,
      )
      .bind(userId, usageDay(now)),
  ]);
  const tally = resultRows<LiveRow>(counts)[0];
  return {
    sessions: tally?.sessions ?? 0,
    busy: tally?.busy ?? 0,
    sessionsToday: tally?.sessions_today ?? 0,
    today: resultRows<ModelRow>(today).map(toModelTotals),
  };
};

export const readStats = async (db: D1Database, userId: string, windows: StatsWindows): Promise<Stats> => {
  const [usage, splits, sessions] = await db.batch<Record<string, unknown>>([
    usageDaysStatement(db, userId, windows.month.from),
    usageSplitsStatement(db, userId, windows.month.from),
    sessionsPerDayStatement(db, userId, windows.month.since),
  ]);
  return {
    windows,
    usage: resultRows<ModelBucketRow>(usage).map((row) => ({ bucket: row.bucket, ...toModelTotals(row) })),
    splits: resultRows<SplitRow>(splits).map((row) => ({
      field: row.field,
      value: row.value,
      ...toModelTotals(row),
    })),
    sessions: resultRows<SessionsRow>(sessions).map((row) => ({ day: row.day, sessions: row.sessions })),
  };
};

export const readInsights = async (
  db: D1Database,
  userId: string,
  fortnight: DayWindow,
  now: number,
): Promise<Insights> => {
  const [usage, monthly, recalled, stale, memories, repos, allTime, rhythm] = await db.batch<Record<string, unknown>>([
    usageDaysStatement(db, userId, fortnight.from),
    usageMonthsStatement(db, userId),
    workingSetStatement(db, userId, usageDayStart(now) - (USAGE_MONTH_DAYS - 1) * DAY_MS, WORKING_SET_SIZE),
    staleStatement(
      db,
      userId,
      now - STALE_AFTER_DAYS * DAY_MS,
      now - NEVER_RECALLED_AFTER_DAYS * DAY_MS,
      STALE_LIST_SIZE,
    ),
    db.prepare("SELECT COUNT(*) AS memories FROM memories WHERE user_id = ?").bind(userId),
    repoHoursStatement(db, userId, fortnight.since, fortnight.until, REPO_BAR_COUNT),
    repoHoursStatement(db, userId, 0, now, REPO_BAR_COUNT),
    rhythmStatement(db, userId, fortnight.since),
  ]);
  const recalls = resultRows<RecallRow>(recalled);
  const staleRows = resultRows<StaleRow>(stale);
  return {
    fortnight,
    usage: resultRows<ModelBucketRow>(usage).map((row) => ({ bucket: row.bucket, ...toModelTotals(row) })),
    monthly: resultRows<ModelBucketRow>(monthly).map((row) => ({ bucket: row.bucket, ...toModelTotals(row) })),
    working: {
      entries: recalls.map((row) => ({ name: row.name, recalls: row.recall_count })),
      recalls: recalls[0]?.total_recalls ?? 0,
    },
    stale: {
      entries: staleRows.map((row) => ({
        name: row.name,
        recalled: row.recall_count > 0,
        lastRecalledAt: row.last_recalled_at,
        createdAt: row.created_at,
      })),
      atRisk: staleRows[0]?.at_risk ?? 0,
      total: resultRows<MemoryTotalRow>(memories)[0]?.memories ?? 0,
    },
    repos: resultRows<RepoRow>(repos).map((row) => ({ repo: row.repo, ms: row.ms, sessions: row.sessions })),
    allTime: resultRows<RepoRow>(allTime).map((row) => ({ repo: row.repo, ms: row.ms, sessions: row.sessions })),
    rhythm: resultRows<RhythmRow>(rhythm).map((row) => ({
      weekday: row.weekday,
      hour: row.hour,
      sessions: row.sessions,
    })),
  };
};

// The device one session is live on, which is the only address a message to it can carry. A
// session the account no longer has running has none, and saying so is what stops the dashboard
// queueing a message no host will ever read.
export const liveSessionDevice = async (
  db: D1Database,
  userId: string,
  sessionId: string,
  now: number,
): Promise<string | null> => {
  const row = await db
    .prepare("SELECT device_id FROM sessions WHERE user_id = ? AND session_id = ? AND last_activity_at > ?")
    .bind(userId, sessionId, now - SESSION_TTL_MS)
    .first<{ device_id: string }>();
  return row === null ? null : row.device_id;
};

export const sessionOnDevice = async (
  db: D1Database,
  userId: string,
  sessionId: string,
  deviceId: string,
  now: number,
): Promise<boolean> => (await liveSessionDevice(db, userId, sessionId, now)) === deviceId;

// What one session spent, and on whose account. The rollup cannot answer either: it is keyed by
// day, host, repo and account and never by session, so the raw events are the only reading that
// holds a session together. They are swept at two weeks unless the reading was taken from the
// transcript, and the page says that rather than printing an old session's spend as nothing.
export const sessionSpend = async (db: D1Database, userId: string, sessionId: string): Promise<SessionSpend[]> => {
  const { results } = await db
    .prepare(
      `SELECT account, provider, model, ${COUNT_SUMS} FROM usage_events
       WHERE user_id = ?1 AND session_id = ?2
       GROUP BY account, provider, model ORDER BY account, provider, model`,
    )
    .bind(userId, sessionId)
    .all<ModelRow & { account: string }>();
  return results.map((row) => ({ account: row.account, ...toModelTotals(row) }));
};

// Whether this account has the session at all, running or long over. A transcript outlives the
// device that wrote it — a host signs in again and carries a new device id — so what a stretch is
// checked against is the account, and the object key it lands under is the caller's own.
export const sessionOnRecord = async (db: D1Database, userId: string, sessionId: string): Promise<boolean> => {
  const row = await db
    .prepare(
      `SELECT session_id FROM sessions WHERE user_id = ?1 AND session_id = ?2
       UNION ALL
       SELECT session_id FROM session_history WHERE user_id = ?1 AND session_id = ?2`,
    )
    .bind(userId, sessionId)
    .first<{ session_id: string }>();
  return row !== null;
};

const USAGE_SUMS =
  "prompts = usage_daily.prompts + excluded.prompts, " +
  "input_tokens = usage_daily.input_tokens + excluded.input_tokens, " +
  "output_tokens = usage_daily.output_tokens + excluded.output_tokens, " +
  "cache_write_tokens = usage_daily.cache_write_tokens + excluded.cache_write_tokens, " +
  "cache_read_tokens = usage_daily.cache_read_tokens + excluded.cache_read_tokens";

export const recordUsage = async (
  db: D1Database,
  userId: string,
  sessionId: string,
  input: UsageInput,
  now: number,
): Promise<void> => {
  const counters = [
    input.prompts,
    input.inputTokens,
    input.outputTokens,
    input.cacheWriteTokens,
    input.cacheReadTokens,
  ];
  await db.batch([
    db
      .prepare(
        `INSERT INTO usage_daily (user_id, day, host, repo, account, provider, model, prompts,
           input_tokens, output_tokens, cache_write_tokens, cache_read_tokens)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
         WHERE NOT EXISTS (SELECT 1 FROM usage_events WHERE user_id = ?1 AND session_id = ?13 AND seq = ?14)
         ON CONFLICT (user_id, day, host, repo, account, provider, model) DO UPDATE SET ${USAGE_SUMS}`,
      )
      .bind(
        userId,
        usageDay(input.at),
        input.host,
        input.repo,
        input.account,
        input.provider,
        input.model,
        ...counters,
        sessionId,
        input.seq,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO usage_events (user_id, session_id, seq, provider, account, model, prompts,
           input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, at, recorded_at, durable)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      )
      .bind(
        userId,
        sessionId,
        input.seq,
        input.provider,
        input.account,
        input.model,
        ...counters,
        input.at,
        now,
        input.durable ? 1 : 0,
      ),
    db
      .prepare("DELETE FROM usage_events WHERE user_id = ? AND recorded_at < ? AND durable = 0")
      .bind(userId, now - USAGE_RETENTION_MS),
    ...input.files.map((file) =>
      db
        .prepare("INSERT OR IGNORE INTO counted_files (user_id, session_id, file) VALUES (?, ?, ?)")
        .bind(userId, sessionId, file),
    ),
  ]);
};

// The transcript files of one session whose tokens have been counted, whoever counted them: the
// hooks as the session ran, or a run reading the file back long after. It is the only thing a
// later reading can ask, since the raw events are swept at two weeks and never said which file
// they read.
// How far one session's archive runs and how far the index has read of it. `archived` is a cache
// of the objects, moved by the storage event that wrote them; `indexed` and `chunks` are the
// index's own and no listing could recover them.
export interface IndexMark {
  archived: number;
  indexed: number;
  chunks: number;
}

export const indexMark = async (db: D1Database, userId: string, sessionId: string): Promise<IndexMark | null> =>
  db
    .prepare("SELECT archived, bytes AS indexed, chunks FROM session_index WHERE user_id = ?1 AND session_id = ?2")
    .bind(userId, sessionId)
    .first<IndexMark>();

export interface IndexedChunk {
  speaker: string;
  text: string;
  at: number;
  embedding: Uint8Array;
}

// What one indexing pass produced, written in one batch with the mark that says how far it read.
// The chunks are appended under ordinals that only climb, so a session indexed again after it was
// resumed adds to what is there and nothing already indexed is rewritten or lost.
export const writeChunks = async (
  db: D1Database,
  userId: string,
  sessionId: string,
  from: number,
  chunks: IndexedChunk[],
  reached: number,
): Promise<void> => {
  if (chunks.length > 0) {
    await db.batch(
      chunks.map((chunk, index) =>
        db
          .prepare(
            `INSERT INTO session_chunks (user_id, session_id, ordinal, speaker, text, embedding, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (user_id, session_id, ordinal) DO NOTHING`,
          )
          .bind(userId, sessionId, from + index, chunk.speaker, chunk.text, chunk.embedding, chunk.at),
      ),
    );
  }
  await db
    .prepare("UPDATE session_index SET bytes = ?3, chunks = ?4 WHERE user_id = ?1 AND session_id = ?2")
    .bind(userId, sessionId, reached, from + chunks.length)
    .run();
};

export interface ChunkCandidate {
  chunkSeq: number;
  sessionId: string;
  speaker: string;
  embedding: Uint8Array;
}

// Every chunk this account holds, without its text. A search scores all of them: a vector is 388
// bytes, so a few thousand chunks is under a megabyte and a few thousand dot products of 384
// dimensions, which is the same shape the memory search has always had. The prose is read back
// only for the chunks that win, since carrying it here would be ten times the bytes.
export const chunkVectors = async (db: D1Database, userId: string): Promise<ChunkCandidate[]> => {
  const rows = await db
    .prepare("SELECT chunk_seq, session_id, speaker, embedding FROM session_chunks WHERE user_id = ?")
    .bind(userId)
    .raw<[number, string, string, unknown]>();
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

export const chunkMatches = async (
  db: D1Database,
  userId: string,
  match: string,
  limit: number,
): Promise<ChunkMatch[]> => {
  const { results } = await db
    .prepare(
      `SELECT c.chunk_seq, c.session_id, c.speaker FROM session_chunks_fts f
       JOIN session_chunks c ON c.chunk_seq = f.rowid
       WHERE session_chunks_fts MATCH ?2 AND c.user_id = ?1
       ORDER BY bm25(session_chunks_fts) LIMIT ?3`,
    )
    .bind(userId, match, limit)
    .all<{ chunk_seq: number; session_id: string; speaker: string }>();
  return results.map((row) => ({ chunkSeq: row.chunk_seq, sessionId: row.session_id, speaker: row.speaker }));
};

export interface Excerpt {
  speaker: string;
  text: string;
  at: number;
}

export const chunkExcerpts = async (
  db: D1Database,
  userId: string,
  chunkSeqs: number[],
): Promise<Map<number, Excerpt>> => {
  const { results } = await db
    .prepare(
      `SELECT chunk_seq, speaker, text, at FROM session_chunks
       WHERE user_id = ? AND chunk_seq IN (SELECT value FROM json_each(?))`,
    )
    .bind(userId, JSON.stringify(chunkSeqs))
    .all<{ chunk_seq: number; speaker: string; text: string; at: number }>();
  return new Map(results.map((row) => [row.chunk_seq, { speaker: row.speaker, text: row.text, at: row.at }]));
};

export const countedFiles = async (db: D1Database, userId: string, sessionId: string): Promise<string[]> => {
  const { results } = await db
    .prepare("SELECT file FROM counted_files WHERE user_id = ? AND session_id = ? ORDER BY file")
    .bind(userId, sessionId)
    .all<{ file: string }>();
  return results.map((row) => row.file);
};

interface ArtifactRow {
  name: string;
  rev: number;
  type: ArtifactType;
  title: string;
  description: string;
  read_perm: ReadPermission;
  write_perm: WritePermission;
  entry_path: string;
  files: string;
  file_count: number;
  bytes: number;
  created_at: number;
  updated_at: number;
  user_id: string;
  last_writer: string;
}

// `last_writer` is the writer's first email. A device token carries a user and `principals` maps
// several emails to one, so the account is as precise as the writer can be named; an account whose
// emails have all been withdrawn names none.
const ARTIFACT_COLUMNS = `a.name, a.rev, a.type, a.title, a.description, a.read_perm, a.write_perm, a.entry_path,
  a.files, a.file_count, a.bytes, a.created_at, a.updated_at, a.user_id,
  COALESCE((SELECT email FROM principals WHERE user_id = a.last_writer_user_id ORDER BY email LIMIT 1), '') AS last_writer`;

const toArtifact = (row: ArtifactRow): ArtifactRecord => ({
  name: row.name,
  rev: row.rev,
  type: row.type,
  title: row.title,
  description: row.description,
  read: row.read_perm,
  write: row.write_perm,
  entryPath: row.entry_path,
  files: JSON.parse(row.files) as ArtifactFile[],
  fileCount: row.file_count,
  bytes: row.bytes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ownerUserId: row.user_id,
  lastWriter: row.last_writer,
});

// artifacts_by_updated, the unique (user_id, name) and artifacts_by_bytes in that order.
const ARTIFACT_ORDERS: Record<string, Order<ArtifactRecord>> = {
  newest: {
    keyset: "(a.updated_at < ?3 OR (a.updated_at = ?3 AND a.name > ?4))",
    by: "a.updated_at DESC, a.name",
    direction: "desc",
    cursorOf: (artifact) => [artifact.updatedAt, artifact.name],
  },
  name: {
    keyset: "a.name > ?3",
    by: "a.name",
    direction: "asc",
    cursorOf: (artifact) => [artifact.name, artifact.name],
  },
  largest: {
    keyset: "(a.bytes < ?3 OR (a.bytes = ?3 AND a.name > ?4))",
    by: "a.bytes DESC, a.name",
    direction: "desc",
    cursorOf: (artifact) => [artifact.bytes, artifact.name],
  },
};

export const artifactCursorDirection = (sort: string): "desc" | "asc" => orderFor(ARTIFACT_ORDERS, sort).direction;

export const getArtifact = async (db: D1Database, userId: string, name: string): Promise<ArtifactRecord | null> => {
  const row = await db
    .prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts a WHERE a.user_id = ?1 AND a.name = ?2`)
    .bind(userId, name)
    .first<ArtifactRow>();
  return row === null ? null : toArtifact(row);
};

// Which artifact a name on the artifact hostname means. The reader's own comes first and is served
// whatever its read permission says; otherwise the one published for the account to read. A name
// that holds neither is the caller's 404, and so is one the read permission refuses.
export const resolveArtifact = async (
  db: D1Database,
  readerUserId: string,
  name: string,
): Promise<ArtifactRecord | null> => {
  const own = await getArtifact(db, readerUserId, name);
  if (own !== null) return own;
  const shared = await db
    .prepare(
      `SELECT ${ARTIFACT_COLUMNS} FROM artifacts a
       WHERE a.name = ?1 AND a.read_perm = 'account' ORDER BY a.user_id LIMIT 1`,
    )
    .bind(name)
    .first<ArtifactRow>();
  return shared === null ? null : toArtifact(shared);
};

export const listArtifactPage = async (
  db: D1Database,
  userId: string,
  input: ArtifactListInput,
  [cursorAt, cursorName]: Cursor,
): Promise<{ artifacts: ArtifactRecord[]; nextCursor: string }> => {
  const order = orderFor(ARTIFACT_ORDERS, input.sort);
  const { results } = await db
    .prepare(
      `SELECT ${ARTIFACT_COLUMNS} FROM artifacts a
       WHERE a.user_id = ?1 AND (?2 = '' OR a.type = ?2) AND ${order.keyset}
       ORDER BY ${order.by}
       LIMIT ?5`,
    )
    .bind(userId, input.type, cursorAt, cursorName, input.limit + 1)
    .all<ArtifactRow>();
  const artifacts = results.slice(0, input.limit).map(toArtifact);
  const last = artifacts.at(-1);
  const nextCursor = results.length > input.limit && last ? encodeCursor(...order.cursorOf(last)) : "";
  return { artifacts, nextCursor };
};

// The shelf by what a reader typed, name heaviest, then title, then description — the weights the
// memory search already uses over the same three fields.
export const searchArtifacts = async (
  db: D1Database,
  userId: string,
  type: string,
  match: string,
  limit: number,
): Promise<{ artifacts: ArtifactRecord[]; cut: boolean }> => {
  const { results } = await db
    .prepare(
      `SELECT ${ARTIFACT_COLUMNS} FROM artifacts_fts f JOIN artifacts a ON a.artifact_seq = f.rowid
       WHERE artifacts_fts MATCH ?2 AND a.user_id = ?1 AND (?3 = '' OR a.type = ?3)
       ORDER BY bm25(artifacts_fts, 5.0, 2.0, 1.0) LIMIT ?4`,
    )
    .bind(userId, match, type, limit + 1)
    .all<ArtifactRow>();
  return { artifacts: results.slice(0, limit).map(toArtifact), cut: results.length > limit };
};

export interface ArtifactCounts {
  total: number;
  byType: Array<{ type: ArtifactType; count: number }>;
}

// The second read a page of the shelf costs: the total for the heading and a count per type for
// the chips. It walks the account's own rows, which is what the memory counts already do.
export const artifactCounts = async (db: D1Database, userId: string): Promise<ArtifactCounts> => {
  const { results } = await db
    .prepare("SELECT type, COUNT(*) AS n FROM artifacts WHERE user_id = ?1 GROUP BY type")
    .bind(userId)
    .all<{ type: ArtifactType; n: number }>();
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
  writerUserId: string;
}

// The revision the caller owns, claimed before a byte of it is written. The upsert is what makes
// the claim exclusive: two publishes of one name read the same live revision and each is handed a
// different number here, so neither streams into the prefix the other will commit.
export const claimRevision = async (db: D1Database, userId: string, name: string): Promise<number> => {
  const row = await db
    .prepare(
      `INSERT INTO artifact_revisions (user_id, name, rev_next) VALUES (?1, ?2, 1)
       ON CONFLICT (user_id, name) DO UPDATE SET rev_next = artifact_revisions.rev_next + 1
       RETURNING rev_next`,
    )
    .bind(userId, name)
    .first<{ rev_next: number }>();
  if (row === null) throw new Error(`claiming a revision of ${name} returned no row`);
  return row.rev_next;
};

const entryOf = (commit: ArtifactCommit): ArtifactFile => {
  const entry = commit.files[0];
  if (entry === undefined) throw new Error(`a publish of ${commit.name} named no file`);
  return entry;
};

const bytesOf = (commit: ArtifactCommit): number => commit.files.reduce((running, file) => running + file.bytes, 0);

// The publish of a name that held nothing when the gates ran. `UNIQUE (user_id, name)` is what
// decides a race between two first publishes: the second writes no row and is told the name is
// taken rather than replacing what the first one just committed.
export const createArtifact = async (db: D1Database, commit: ArtifactCommit): Promise<boolean> => {
  const result = await db
    .prepare(
      `INSERT INTO artifacts (user_id, name, rev, type, title, description, read_perm, write_perm,
                              entry_path, files, file_count, bytes, created_at, updated_at,
                              last_writer_user_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14)
       ON CONFLICT (user_id, name) DO NOTHING`,
    )
    .bind(
      commit.userId,
      commit.name,
      commit.rev,
      commit.type,
      commit.title,
      commit.description,
      commit.read,
      commit.write,
      entryOf(commit).path,
      JSON.stringify(commit.files),
      commit.files.length,
      bytesOf(commit),
      commit.at,
      commit.writerUserId,
    )
    .run();
  return result.meta.changes > 0;
};

// The publish of a name that held an artifact. The WHERE makes it a compare-and-swap on the
// revision read before the write: of two publishes racing under one name, one moves the row
// forward and the other changes nothing and is told so. A row that has since been unpublished
// matches nothing, so the publish is refused rather than recreating an artifact whose files the
// unpublish has already deleted. `created_at` is left alone, because the artifact is being
// replaced and not recreated.
export const replaceArtifact = async (db: D1Database, commit: ArtifactCommit, fromRev: number): Promise<boolean> => {
  const result = await db
    .prepare(
      `UPDATE artifacts SET rev = ?3, type = ?4, title = ?5, description = ?6, read_perm = ?7,
                            write_perm = ?8, entry_path = ?9, files = ?10, file_count = ?11,
                            bytes = ?12, updated_at = ?13, last_writer_user_id = ?14
       WHERE user_id = ?1 AND name = ?2 AND rev = ?15`,
    )
    .bind(
      commit.userId,
      commit.name,
      commit.rev,
      commit.type,
      commit.title,
      commit.description,
      commit.read,
      commit.write,
      entryOf(commit).path,
      JSON.stringify(commit.files),
      commit.files.length,
      bytesOf(commit),
      commit.at,
      commit.writerUserId,
      fromRev,
    )
    .run();
  return result.meta.changes > 0;
};

export const deleteArtifactRow = async (db: D1Database, userId: string, name: string): Promise<boolean> => {
  const result = await db.prepare("DELETE FROM artifacts WHERE user_id = ?1 AND name = ?2").bind(userId, name).run();
  return result.meta.changes > 0;
};

// Whether another account already publishes this name for the account to read. The hostname has no
// user segment, so two account-readable artifacts under one name would be two artifacts at one
// address; the second publish is refused rather than resolved by an arbitrary tie-break.
export const accountReadableElsewhere = async (db: D1Database, userId: string, name: string): Promise<boolean> => {
  const row = await db
    .prepare("SELECT user_id FROM artifacts WHERE name = ?2 AND read_perm = 'account' AND user_id <> ?1 LIMIT 1")
    .bind(userId, name)
    .first<{ user_id: string }>();
  return row !== null;
};

interface ShareRow {
  share_id: string;
  user_id: string;
  name: string;
  mode: ShareMode;
  subject: string;
  created_at: number;
  expires_at: number;
  last_used_at: number;
  uses: number;
}

const SHARE_FIELDS = "share_id, user_id, name, mode, subject, created_at, expires_at, last_used_at, uses";

const SHARE_COLUMNS = `${SHARE_FIELDS} FROM artifact_shares`;

const toShare = (row: ShareRow): ShareRecord => ({
  shareId: row.share_id,
  userId: row.user_id,
  name: row.name,
  mode: row.mode,
  subject: row.subject,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
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

// One placeholder per name, numbered from `from`. A listing page holds at most a hundred rows, so
// the read is bounded by the page rather than by the account.
const placeholders = (count: number, from: number): string =>
  Array.from({ length: count }, (_one, index) => `?${from + index}`).join(", ");

// The two reads that resolve a credential, and the only two that do not filter on the expiry: a
// read of a share's own address is what finds it dead and deletes it, so the row has to come back
// before the window is compared. Both are one read by a unique key, which is what keeps a guess at
// an unauthenticated address to one read and no write.
export const shareByToken = async (db: D1Database, hash: string): Promise<ShareRecord | null> => {
  const row = await db
    .prepare(`SELECT ${SHARE_COLUMNS} WHERE mode = 'link' AND subject = ?1`)
    .bind(hash)
    .first<ShareRow>();
  return row === null ? null : toShare(row);
};

export const shareById = async (db: D1Database, shareId: string): Promise<ShareRecord | null> => {
  const row = await db
    .prepare(`SELECT ${SHARE_COLUMNS} WHERE share_id = ?1 AND mode = 'email'`)
    .bind(shareId)
    .first<ShareRow>();
  return row === null ? null : toShare(row);
};

// One artifact's live shares, link row first. `'link'` sorts after `'email'`, so the descending
// mode puts it there and artifact_shares_by_artifact supplies the order; nothing is sorted here.
export const artifactShares = async (
  db: D1Database,
  userId: string,
  name: string,
  now: number,
): Promise<ShareRecord[]> => {
  const { results } = await db
    .prepare(
      `SELECT ${SHARE_COLUMNS}
       WHERE user_id = ?1 AND name = ?2 AND expires_at > ?3
       ORDER BY mode DESC, created_at`,
    )
    .bind(userId, name, now)
    .all<ShareRow>();
  return results.map(toShare);
};

// The live shares of the artifacts on one page of a listing, grouped rather than read per row.
export const sharesFor = async (
  db: D1Database,
  userId: string,
  names: readonly string[],
  now: number,
): Promise<Map<string, ShareRecord[]>> => {
  const held = new Map<string, ShareRecord[]>();
  if (names.length === 0) return held;
  const { results } = await db
    .prepare(
      `SELECT ${SHARE_COLUMNS}
       WHERE user_id = ?1 AND expires_at > ?2 AND name IN (${placeholders(names.length, 3)})
       ORDER BY name, mode DESC, created_at`,
    )
    .bind(userId, now, ...names)
    .all<ShareRow>();
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
  db: D1Database,
  userId: string,
  names: readonly string[],
  now: number,
): Promise<Map<string, number>> => {
  if (names.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT name, COUNT(*) AS n FROM artifact_shares
       WHERE user_id = ?1 AND expires_at > ?2 AND name IN (${placeholders(names.length, 3)})
       GROUP BY name`,
    )
    .bind(userId, now, ...names)
    .all<{ name: string; n: number }>();
  return new Map(results.map((row) => [row.name, row.n]));
};

export const shareCount = async (db: D1Database, userId: string, name: string, now: number): Promise<number> => {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM artifact_shares WHERE user_id = ?1 AND name = ?2 AND expires_at > ?3")
    .bind(userId, name, now)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

// The one write a page view under a share prefix costs. A file read and the player's script cost
// none, so a reader seeking through a track does not write a row per range request.
export const recordShareUse = async (db: D1Database, shareId: string, at: number): Promise<void> => {
  await db
    .prepare("UPDATE artifact_shares SET uses = uses + 1, last_used_at = ?2 WHERE share_id = ?1")
    .bind(shareId, at)
    .run();
};

// The row a read of its own address found past its expiry, named by its primary key. It is the
// request the reader made that deletes it, and the window is compared again in the statement so a
// renewal that landed in between is not thrown away.
export const deleteExpiredShare = async (db: D1Database, shareId: string, at: number): Promise<void> => {
  await db.prepare("DELETE FROM artifact_shares WHERE share_id = ?1 AND expires_at <= ?2").bind(shareId, at).run();
};

export const deleteArtifactShares = async (db: D1Database, userId: string, name: string): Promise<number> => {
  const result = await db
    .prepare("DELETE FROM artifact_shares WHERE user_id = ?1 AND name = ?2")
    .bind(userId, name)
    .run();
  return result.meta.changes;
};

// A dead share for the address about to be shared again, named by its full key. Without it the
// upsert below would revive the dead row and carry its use count into the new share.
export const deleteDeadEmailShare = async (
  db: D1Database,
  userId: string,
  name: string,
  address: string,
  at: number,
): Promise<void> => {
  await db
    .prepare(
      `DELETE FROM artifact_shares
       WHERE user_id = ?1 AND name = ?2 AND mode = 'email' AND subject = ?3 AND expires_at <= ?4`,
    )
    .bind(userId, name, address, at)
    .run();
};

// One statement for a first share and a renewal both: the returned id differing from the one
// generated is what says the address already held a live share and its expiry moved instead.
export const createEmailShare = async (
  db: D1Database,
  input: ShareInput,
): Promise<{ share: ShareRecord; renewed: boolean }> => {
  const row = await db
    .prepare(
      `INSERT INTO artifact_shares (share_id, user_id, name, mode, subject, created_at, expires_at, last_used_at, uses)
       VALUES (?1, ?2, ?3, 'email', ?4, ?5, ?6, ?5, 0)
       ON CONFLICT (user_id, name, mode, subject) DO UPDATE SET expires_at = excluded.expires_at
       RETURNING ${SHARE_FIELDS}`,
    )
    .bind(input.shareId, input.userId, input.name, input.subject, input.at, input.expiresAt)
    .first<ShareRow>();
  if (row === null) throw new Error(`sharing ${input.name} with an address wrote no row`);
  return { share: toShare(row), renewed: row.share_id !== input.shareId };
};

const LINK_UPSERT = `INSERT INTO artifact_shares (share_id, user_id, name, mode, subject, created_at, expires_at, last_used_at, uses)
   VALUES (?1, ?2, ?3, 'link', ?4, ?5, ?6, ?5, 0)
   ON CONFLICT (user_id, name) WHERE mode = 'link'
   DO UPDATE SET share_id = excluded.share_id, subject = excluded.subject, created_at = excluded.created_at,
     expires_at = excluded.expires_at, last_used_at = excluded.last_used_at, uses = 0`;

const LINK_RETURNING = `RETURNING ${SHARE_FIELDS}`;

// The first link share on an artifact. artifact_shares_one_link is what makes a second one
// impossible even under a race: a live row refuses the update and no row comes back, which is the
// answer that asks the owner whether to replace the address already in use. A dead row is
// overwritten, because it opens nothing.
export const createLinkShare = async (db: D1Database, input: ShareInput): Promise<ShareRecord | null> => {
  const row = await db
    .prepare(`${LINK_UPSERT} WHERE artifact_shares.expires_at <= excluded.created_at ${LINK_RETURNING}`)
    .bind(input.shareId, input.userId, input.name, input.subject, input.at, input.expiresAt)
    .first<ShareRow>();
  return row === null ? null : toShare(row);
};

// The replacement the owner asked for. It retires the old token the moment the new hash lands,
// because one row holds both and the hash is the credential.
export const replaceLinkShare = async (db: D1Database, input: ShareInput): Promise<ShareRecord> => {
  const row = await db
    .prepare(`${LINK_UPSERT} ${LINK_RETURNING}`)
    .bind(input.shareId, input.userId, input.name, input.subject, input.at, input.expiresAt)
    .first<ShareRow>();
  if (row === null) throw new Error(`replacing the link share on ${input.name} wrote no row`);
  return toShare(row);
};

// The window moved forward on a live link share. A row that is already gone changes nothing and
// answers null, which the page draws as the share having been revoked by another request.
export const extendLinkShare = async (
  db: D1Database,
  userId: string,
  name: string,
  now: number,
  expiresAt: number,
): Promise<ShareRecord | null> => {
  const row = await db
    .prepare(
      `UPDATE artifact_shares SET expires_at = ?4
       WHERE user_id = ?1 AND name = ?2 AND mode = 'link' AND expires_at > ?3
       ${LINK_RETURNING}`,
    )
    .bind(userId, name, now, expiresAt)
    .first<ShareRow>();
  return row === null ? null : toShare(row);
};

// What a revoke names. Every member is scoped to the owner and the artifact, so a share id from
// another artifact deletes nothing even where a caller names one.
export type RevokeScope =
  | { kind: "one"; shareId: string }
  | { kind: "link" }
  | { kind: "email"; address: string }
  | { kind: "all" };

export const revokeShares = async (
  db: D1Database,
  userId: string,
  name: string,
  scope: RevokeScope,
): Promise<number> => {
  const where =
    scope.kind === "one"
      ? "AND share_id = ?3"
      : scope.kind === "link"
        ? "AND mode = 'link'"
        : scope.kind === "email"
          ? "AND mode = 'email' AND subject = ?3"
          : "";
  const statement = db.prepare(`DELETE FROM artifact_shares WHERE user_id = ?1 AND name = ?2 ${where}`);
  const bound =
    scope.kind === "one"
      ? statement.bind(userId, name, scope.shareId)
      : scope.kind === "email"
        ? statement.bind(userId, name, scope.address)
        : statement.bind(userId, name);
  const result = await bound.run();
  return result.meta.changes;
};

const LEGACY_PAGE = 1_000;

// The artifacts published before a row carried their type. The operator runs it once per
// deployment: a migration cannot read the bucket and nothing may scan on a schedule, so this is
// the one listing of a user's prefix in the feature and it is a request that asks for it.
//
// The delimiter leaves out everything under the container layout, so only the bare keys answer and
// a row that already exists is left exactly as it is.
export const adoptArtifacts = async (db: D1Database, bucket: R2Bucket, userId: string): Promise<number> => {
  const prefix = `${userId}/`;
  const legacy: R2Object[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, delimiter: "/", cursor, limit: LEGACY_PAGE });
    legacy.push(...page.objects);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  const { results } = await db
    .prepare("SELECT name FROM artifacts WHERE user_id = ?1")
    .bind(userId)
    .all<{ name: string }>();
  const known = new Set(results.map((row) => row.name));
  const taking = legacy.filter((object) => !known.has(object.key.slice(prefix.length)));
  if (taking.length === 0) return 0;
  await db.batch(
    taking.map((object) => {
      const name = object.key.slice(prefix.length);
      const files: ArtifactFile[] = [{ path: name, bytes: object.size, contentType: contentTypeFor(name) }];
      return db
        .prepare(
          `INSERT INTO artifacts (user_id, name, rev, type, title, description, read_perm, write_perm,
                                  entry_path, files, file_count, bytes, created_at, updated_at,
                                  last_writer_user_id)
           VALUES (?1, ?2, 0, 'site', ?2, '', 'private', 'owner', ?2, ?3, 1, ?4, ?5, ?5, ?1)
           ON CONFLICT (user_id, name) DO NOTHING`,
        )
        .bind(userId, name, JSON.stringify(files), object.size, object.uploaded.getTime());
    }),
  );
  return taking.length;
};

export const recall = async (db: D1Database, userId: string, memoryIds: string[], now: number): Promise<Memory[]> => {
  const ids = JSON.stringify(memoryIds);
  const [, selected] = await db.batch<MemoryRow>([
    db
      .prepare(
        `UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ?
         WHERE user_id = ? AND memory_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(now, userId, ids),
    db
      .prepare(
        `SELECT ${MEMORY_COLUMNS} FROM memories m WHERE m.user_id = ? AND m.memory_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(userId, ids),
  ]);
  return (selected?.results ?? []).map(toMemory);
};
