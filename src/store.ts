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

const encodeCursor = (at: number, id: string): string => btoa(JSON.stringify([at, id]));

const readCursorJson = (cursor: string): unknown => {
  try {
    return JSON.parse(atob(cursor));
  } catch {
    return null;
  }
};

export const decodeCursor = (cursor: string): [number, string] | null => {
  if (cursor === "") return [Number.MAX_SAFE_INTEGER, ""];
  const parsed = readCursorJson(cursor);
  if (!Array.isArray(parsed) || typeof parsed[0] !== "number" || typeof parsed[1] !== "string") return null;
  return [parsed[0], parsed[1]];
};

export const listMemories = async (
  db: D1Database,
  userId: string,
  input: ListInput,
  [cursorCreatedAt, cursorId]: [number, string],
): Promise<{ memories: Memory[]; nextCursor: string }> => {
  const { results } = await db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories m
       WHERE m.user_id = ?1 AND ${TAG_FILTER} AND ${typeFilter(7)} AND m.created_at >= ?3
         AND (m.created_at < ?4 OR (m.created_at = ?4 AND m.memory_id < ?5))
       ORDER BY m.created_at DESC, m.memory_id DESC
       LIMIT ?6`,
    )
    .bind(
      userId,
      JSON.stringify(input.tags),
      input.since,
      cursorCreatedAt,
      cursorId,
      input.limit + 1,
      JSON.stringify(input.types),
    )
    .all<MemoryRow>();
  const memories = results.slice(0, input.limit).map(toMemory);
  const last = memories.at(-1);
  const nextCursor = results.length > input.limit && last ? encodeCursor(last.createdAt, last.memoryId) : "";
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
           branch, commit_subject, started_at, last_activity_at, prompts, focus_first, focus_latest, mode)
         SELECT s.user_id, s.session_id, s.device_id, COALESCE(d.name, ''), s.host, s.cwd, s.repo,
           s.branch, s.commit_subject, s.started_at, s.last_activity_at, s.prompts, s.focus_first, s.focus_latest,
           s.mode
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
        `SELECT s.session_id, COALESCE(d.name, '') AS device_name, s.device_id, s.host, s.cwd, s.repo, s.branch,
           s.commit_subject, s.started_at, s.last_activity_at, s.prompts, s.focus_first, s.focus_latest, s.mode,
           s.permission_mode, s.pid
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
  host: string;
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
  host: row.host,
  repo: row.repo,
  branch: row.branch,
  startedAt: row.started_at,
  lastActivityAt: row.last_activity_at,
  prompts: row.prompts,
  focus: { first: row.focus_first, latest: row.focus_latest },
  running: row.running === 1,
});

export const listSessionHistory = async (
  db: D1Database,
  userId: string,
  input: HistoryInput,
  [cursorLastActivityAt, cursorSessionId]: [number, string],
  now: number,
): Promise<{ sessions: PastSession[]; nextCursor: string }> => {
  const { results } = await db
    .prepare(
      `SELECT h.session_id, h.device_name, h.host, h.repo, h.branch, h.started_at, h.last_activity_at, h.prompts,
         h.focus_first, h.focus_latest, s.session_id IS NOT NULL AS running
       FROM session_history h
       LEFT JOIN sessions s ON s.user_id = h.user_id AND s.session_id = h.session_id AND s.last_activity_at > ?7
       WHERE h.user_id = ?1 AND (?2 = '' OR h.host = ?2) AND (?3 = '' OR h.repo = ?3)
         AND (h.last_activity_at < ?4 OR (h.last_activity_at = ?4 AND h.session_id < ?5))
       ORDER BY h.last_activity_at DESC, h.session_id DESC
       LIMIT ?6`,
    )
    .bind(userId, input.host, input.repo, cursorLastActivityAt, cursorSessionId, input.limit + 1, now - SESSION_TTL_MS)
    .all<PastSessionRow>();
  const sessions = results.slice(0, input.limit).map(toPastSession);
  const last = sessions.at(-1);
  const nextCursor = results.length > input.limit && last ? encodeCursor(last.lastActivityAt, last.sessionId) : "";
  return { sessions, nextCursor };
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

export const sessionOnDevice = async (
  db: D1Database,
  userId: string,
  sessionId: string,
  deviceId: string,
  now: number,
): Promise<boolean> => {
  const row = await db
    .prepare(
      `SELECT session_id FROM sessions
       WHERE user_id = ? AND session_id = ? AND device_id = ? AND last_activity_at > ?`,
    )
    .bind(userId, sessionId, deviceId, now - SESSION_TTL_MS)
    .first<{ session_id: string }>();
  return row !== null;
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
  ]);
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
