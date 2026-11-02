import type { Caller } from "./device";
import {
  type ListInput,
  type Memory,
  type MemoryCounts,
  type MemoryType,
  type SaveInput,
  SESSION_HISTORY_TTL_MS,
  SESSION_TTL_MS,
  type Session,
  type SessionHistory,
  type SessionInput,
  type SessionMode,
  sessionHandle,
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

const encodeCursor = (memory: Memory): string => btoa(JSON.stringify([memory.createdAt, memory.memoryId]));

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
  const nextCursor = results.length > input.limit && last ? encodeCursor(last) : "";
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

interface SessionHistoryRow {
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
}

interface SessionRow extends SessionHistoryRow {
  permission_mode: string;
  pid: number;
}

const SESSION_HISTORY_COLUMNS = `s.session_id, COALESCE(d.name, '') AS device_name, s.device_id, s.host, s.cwd,
  s.repo, s.branch, s.commit_subject, s.started_at, s.last_activity_at, s.prompts, s.focus_first, s.focus_latest,
  s.mode`;

const toSessionHistory = (row: SessionHistoryRow): SessionHistory => ({
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
});

const toSession = (row: SessionRow): Session => ({
  ...toSessionHistory(row),
  permissionMode: row.permission_mode,
  pid: row.pid,
});

const expireSessions = (db: D1Database, userId: string, now: number): D1PreparedStatement =>
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND last_activity_at <= ?").bind(userId, now - SESSION_TTL_MS);

// Retention rides the write path: the read path derives state and writes nothing.
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
        `INSERT INTO session_history (user_id, session_id, device_id, host, cwd, repo, branch, commit_subject,
           started_at, last_activity_at, prompts, focus_first, focus_latest, mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT (user_id, session_id) DO UPDATE SET
           device_id = excluded.device_id, host = excluded.host, cwd = excluded.cwd, repo = excluded.repo,
           branch = excluded.branch, commit_subject = excluded.commit_subject, started_at = excluded.started_at,
           last_activity_at = excluded.last_activity_at, prompts = excluded.prompts,
           focus_first = excluded.focus_first, focus_latest = excluded.focus_latest, mode = excluded.mode`,
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
      ),
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
        `SELECT ${SESSION_HISTORY_COLUMNS}, s.permission_mode, s.pid
         FROM sessions s LEFT JOIN devices d ON d.device_id = s.device_id AND d.user_id = s.user_id
         WHERE s.user_id = ? ORDER BY s.last_activity_at DESC, s.session_id`,
      )
      .bind(userId),
  ]);
  return (listed?.results ?? []).map(toSession);
};

export const listSessionHistory = async (db: D1Database, userId: string, limit: number): Promise<SessionHistory[]> => {
  const { results } = await db
    .prepare(
      `SELECT ${SESSION_HISTORY_COLUMNS}
       FROM session_history s LEFT JOIN devices d ON d.device_id = s.device_id AND d.user_id = s.user_id
       WHERE s.user_id = ? ORDER BY s.last_activity_at DESC, s.session_id LIMIT ?`,
    )
    .bind(userId, limit)
    .all<SessionHistoryRow>();
  return results.map(toSessionHistory);
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
