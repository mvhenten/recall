import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accountStoreOf } from "../src/db";
import { getMemory, saveMemory, textCandidates, vectorCandidates } from "../src/store";

const db = accountStoreOf(env.DB);

// What a memory carries that the index reads, for one fixed corpus. `in_scope` orders ahead of the
// ranking, so every row is written with a tag and the scoped read asks for one of them.
const MEMORIES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["rank-the-chunks", "bound the vector scan", "a search ranks the chunks it reads", "search"],
  ["bound-the-scan", "rank the history rows", "the vector scan is bounded before it runs", "search"],
  ["move-the-board", "rank the board", "the board moves into the object it belongs to", "board"],
  ["write-the-migration", "write it once", "the migration is written once and applied once", "store"],
  ["scan-the-archive", "scan it twice", "the archive is scanned twice and ranked once", "search"],
];

// name heaviest, then description, then body — the column order `memories_fts` was created in.
const MEMORY_RANKING = `SELECT m.memory_id FROM memories_fts f
   JOIN memories m ON m.memory_seq = f.rowid
   WHERE memories_fts MATCH ?2 AND m.user_id = ?1
   ORDER BY (SELECT count(*) FROM memory_tags t WHERE t.memory_id = m.memory_id AND t.tag = ?3) DESC,
     bm25(memories_fts, 5.0, 2.0, 1.0) LIMIT 50`;

const QUERIES = ["rank", "scan", "archive", "board OR migration", "vector AND scan"];

const NOW = 1_700_000_000_000;

const embeddingFor = (name: string): Uint8Array =>
  Uint8Array.from({ length: 16 }, (_, index) => (name.charCodeAt(index % name.length) + index) % 256);

const withMemories = async (): Promise<string> => {
  const userId = `user-${crypto.randomUUID()}`;
  for (const [name, description, body, tag] of MEMORIES) {
    await saveMemory(db, userId, name, { description, type: "project", body, tags: [tag] }, embeddingFor(name), NOW);
  }
  return userId;
};

describe("the account store", () => {
  it("ranks a memory search by tag scope first and then the way bm25 weights it", async () => {
    const userId = await withMemories();
    for (const query of QUERIES) {
      const { results } = await env.DB.prepare(MEMORY_RANKING)
        .bind(userId, query, "search")
        .all<{ memory_id: string }>();
      const ranked = results.map((row) => row.memory_id);
      expect(ranked).not.toEqual([]);
      const found = await textCandidates(db, userId, ["search"], [], query);
      expect(found.map((candidate) => candidate.memoryId)).toEqual(ranked);
      const scope = found.map((candidate) => candidate.inScope);
      expect(scope).toEqual([...scope].sort((left, right) => Number(right) - Number(left)));
    }
  });

  // Under miniflare D1 hands a blob back as a number array and in production as an ArrayBuffer, so
  // this is the one read that proves a vector survives the round trip byte for byte either way.
  it("hands an embedding back as the bytes it was saved with", async () => {
    const userId = await withMemories();
    const candidates = await vectorCandidates(db, userId, [], []);
    expect(candidates).toHaveLength(MEMORIES.length);
    const byId = new Map(candidates.map((candidate) => [candidate.memoryId, [...candidate.embedding]]));
    for (const [name] of MEMORIES) {
      const saved = await getMemory(db, userId, name);
      expect(saved).not.toBeNull();
      expect(byId.get(saved?.memoryId ?? "")).toEqual([...embeddingFor(name)]);
    }
  });
});
