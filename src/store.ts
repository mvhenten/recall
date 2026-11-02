import type { Caller } from "./device";
import {
  type DaySessions,
  type GoingStale,
  type HistoryFilters,
  type HistoryInput,
  IDLE_AFTER_MS,
  type ListInput,
  type Live,
  type Memory,
  type MemoryCounts,
  type MemoryType,
  type ModelDay,
  type ModelTotals,
  type PastSession,
  type RepoHours,
  type RhythmCell,
  type SaveInput,
  SESSION_HISTORY_TTL_MS,
  SESSION_TTL_MS,
  type Session,
  type SessionInput,
  type SessionMode,
  sessionHandle,
  type TokenCounts,
  USAGE_RETENTION_MS,
  type UsageInput,
  type UsageSplit,
  type UsageSplitField,
  usageDay,
  usageDayStart,
  type WorkingSet,
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

const forgetOldHistory = (db: D1Database, userId: string, now: number): D1PreparedStatement =>
  db
    .prepare("DELETE FROM session_history WHERE user_id = ? AND last_activity_at <= ?")
    .bind(userId, now - SESSION_HISTORY_TTL_MS);

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
    forgetOldHistory(db, caller.userId, now),
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

interface CountRow {
  prompts: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
}

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

const todayUsage = async (
  db: D1Database,
  userId: string,
  now: number,
): Promise<{ sessionsToday: number; today: ModelTotals[] }> => {
  const { results } = await db
    .prepare(
      `SELECT provider, model, ${COUNT_SUMS} FROM usage_daily
       WHERE user_id = ?1 AND day = ?2 GROUP BY provider, model`,
    )
    .bind(userId, usageDay(now))
    .all<CountRow & { provider: string; model: string }>();
  const started = await db
    .prepare("SELECT COUNT(*) AS sessions FROM session_history WHERE user_id = ? AND started_at >= ?")
    .bind(userId, usageDayStart(now))
    .first<{ sessions: number }>();
  return {
    sessionsToday: started?.sessions ?? 0,
    today: results.map((row) => ({ provider: row.provider, model: row.model, ...toCounts(row) })),
  };
};

// Every window the stats page draws reads the daily rollup and nothing else: the counters land in
// usage_daily on the same write that records the raw event, so the current day is already live
// there and the thirty-day window never touches usage_events.
export const usageByModelDay = async (db: D1Database, userId: string, fromDay: string): Promise<ModelDay[]> => {
  const { results } = await db
    .prepare(
      `SELECT day, provider, model, ${COUNT_SUMS} FROM usage_daily
       WHERE user_id = ?1 AND day >= ?2
       GROUP BY day, provider, model ORDER BY day, provider, model`,
    )
    .bind(userId, fromDay)
    .all<CountRow & { day: string; provider: string; model: string }>();
  return results.map((row) => ({ day: row.day, provider: row.provider, model: row.model, ...toCounts(row) }));
};

export const usageSplits = async (db: D1Database, userId: string, fromDay: string): Promise<UsageSplit[]> => {
  const { results } = await db
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
    .bind(userId, fromDay)
    .all<CountRow & { field: UsageSplitField; value: string; provider: string; model: string }>();
  return results.map((row) => ({
    field: row.field,
    value: row.value,
    provider: row.provider,
    model: row.model,
    ...toCounts(row),
  }));
};

export const sessionsPerDay = async (db: D1Database, userId: string, since: number): Promise<DaySessions[]> => {
  const { results } = await db
    .prepare(
      `SELECT date(started_at / 1000, 'unixepoch') AS day, COUNT(*) AS sessions
       FROM session_history WHERE user_id = ? AND started_at >= ?
       GROUP BY day ORDER BY day`,
    )
    .bind(userId, since)
    .all<DaySessions>();
  return results;
};

export const sessionHoursByRepo = async (
  db: D1Database,
  userId: string,
  since: number,
  limit: number,
): Promise<RepoHours[]> => {
  const { results } = await db
    .prepare(
      `SELECT repo, SUM(MAX(last_activity_at - started_at, 0)) AS ms, COUNT(*) AS sessions
       FROM session_history WHERE user_id = ? AND last_activity_at >= ?
       GROUP BY repo ORDER BY ms DESC, repo LIMIT ?`,
    )
    .bind(userId, since, limit)
    .all<RepoHours>();
  return results;
};

export const sessionRhythm = async (db: D1Database, userId: string, since: number): Promise<RhythmCell[]> => {
  const { results } = await db
    .prepare(
      `SELECT CAST(strftime('%w', started_at / 1000, 'unixepoch') AS INTEGER) AS weekday,
         CAST(strftime('%H', started_at / 1000, 'unixepoch') AS INTEGER) AS hour,
         COUNT(*) AS sessions
       FROM session_history WHERE user_id = ? AND started_at >= ?
       GROUP BY weekday, hour ORDER BY sessions DESC, weekday, hour`,
    )
    .bind(userId, since)
    .all<RhythmCell>();
  return results;
};

export const workingSet = async (db: D1Database, userId: string, since: number, limit: number): Promise<WorkingSet> => {
  const { results } = await db
    .prepare(
      `SELECT name, recall_count,
         SUM(recall_count) OVER () AS total_recalls, COUNT(*) OVER () AS total_memories
       FROM memories WHERE user_id = ?1 AND recall_count > 0 AND last_recalled_at >= ?2
       ORDER BY recall_count DESC, name LIMIT ?3`,
    )
    .bind(userId, since, limit)
    .all<{ name: string; recall_count: number; total_recalls: number; total_memories: number }>();
  const first = results[0];
  return {
    entries: results.map((row) => ({ name: row.name, recalls: row.recall_count })),
    recalls: first?.total_recalls ?? 0,
    memories: first?.total_memories ?? 0,
  };
};

export const goingStale = async (
  db: D1Database,
  userId: string,
  staleBefore: number,
  savedBefore: number,
  limit: number,
): Promise<GoingStale> => {
  const [listed, counted] = await db.batch<{
    name: string;
    recall_count: number;
    last_recalled_at: number;
    created_at: number;
    at_risk: number;
  }>([
    db
      .prepare(
        `SELECT name, recall_count, last_recalled_at, created_at, COUNT(*) OVER () AS at_risk
         FROM memories WHERE user_id = ?1
           AND ((recall_count > 0 AND last_recalled_at < ?2) OR (recall_count = 0 AND created_at < ?3))
         ORDER BY (CASE WHEN recall_count = 0 THEN created_at ELSE last_recalled_at END), name
         LIMIT ?4`,
      )
      .bind(userId, staleBefore, savedBefore, limit),
    db.prepare("SELECT COUNT(*) AS at_risk FROM memories WHERE user_id = ?").bind(userId),
  ]);
  const rows = listed?.results ?? [];
  const first = rows[0];
  return {
    entries: rows.map((row) => ({
      name: row.name,
      recalled: row.recall_count > 0,
      lastRecalledAt: row.last_recalled_at,
      createdAt: row.created_at,
    })),
    atRisk: first?.at_risk ?? 0,
    total: counted?.results[0]?.at_risk ?? 0,
  };
};

export const sessionTally = async (db: D1Database, userId: string, now: number): Promise<Live> => {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(last_activity_at > ?2), 0) AS busy
       FROM sessions WHERE user_id = ?1 AND last_activity_at > ?3`,
    )
    .bind(userId, now - IDLE_AFTER_MS, now - SESSION_TTL_MS)
    .first<{ sessions: number; busy: number }>();
  const today = await todayUsage(db, userId, now);
  return { sessions: row?.sessions ?? 0, busy: row?.busy ?? 0, ...today };
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
           input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, at, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(userId, sessionId, input.seq, input.provider, input.account, input.model, ...counters, input.at, now),
    db.prepare("DELETE FROM usage_events WHERE user_id = ? AND recorded_at < ?").bind(userId, now - USAGE_RETENTION_MS),
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
