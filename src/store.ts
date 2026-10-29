import type { ListInput, Memory, MemoryType, SaveInput } from "./model";

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

export const resolvePrincipal = async (db: D1Database, clientId: string): Promise<string | null> => {
  const row = await db
    .prepare("SELECT user_id FROM principals WHERE client_id = ?")
    .bind(clientId)
    .first<{ user_id: string }>();
  return row ? row.user_id : null;
};

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
       WHERE m.user_id = ?1 AND ${TAG_FILTER} AND m.created_at >= ?3
         AND (m.created_at < ?4 OR (m.created_at = ?4 AND m.memory_id < ?5))
       ORDER BY m.created_at DESC, m.memory_id DESC
       LIMIT ?6`,
    )
    .bind(userId, JSON.stringify(input.tags), input.since, cursorCreatedAt, cursorId, input.limit + 1)
    .all<MemoryRow>();
  const memories = results.slice(0, input.limit).map(toMemory);
  const last = memories.at(-1);
  const nextCursor = results.length > input.limit && last ? encodeCursor(last) : "";
  return { memories, nextCursor };
};

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error("embedding column is not a blob");
};

export const vectorCandidates = async (
  db: D1Database,
  userId: string,
  tags: string[],
): Promise<Array<[string, Uint8Array]>> => {
  const rows = await db
    .prepare(`SELECT m.memory_id, m.embedding FROM memories m WHERE m.user_id = ?1 AND ${TAG_FILTER}`)
    .bind(userId, JSON.stringify(tags))
    .raw<[string, unknown]>();
  return rows.map(([memoryId, embedding]) => [memoryId, toBytes(embedding)]);
};

export const textCandidates = async (
  db: D1Database,
  userId: string,
  tags: string[],
  query: string,
): Promise<string[]> => {
  const { results } = await db
    .prepare(
      `SELECT m.memory_id FROM memories_fts f JOIN memories m ON m.memory_seq = f.rowid
       WHERE memories_fts MATCH ?3 AND m.user_id = ?1 AND ${TAG_FILTER}
       ORDER BY bm25(memories_fts, 5.0, 2.0, 1.0) LIMIT 50`,
    )
    .bind(userId, JSON.stringify(tags), query)
    .all<{ memory_id: string }>();
  return results.map((row) => row.memory_id);
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
