import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { type TenantDb, tenantStoreOf } from "../src/db";
import type { HistoryInput } from "../src/model";
import { labels } from "../src/schema/tenant";
import {
  chunkMatches,
  createArtifact,
  endSession,
  getMemory,
  putSession,
  saveMemory,
  searchArtifacts,
  searchSessionHistory,
  textCandidates,
  vectorCandidates,
} from "../src/store";
import { TENANT_MIGRATIONS } from "../src/tenant-migrations";
import { tenantRows } from "./harness";

const storeOf = (userId: string) => env.TENANT.get(env.TENANT.idFromName(userId));

// One account's own store, handed to the shipped reader as the tenant object hands it over.
const inStore = <T>(userId: string, read: (db: TenantDb) => Promise<T>): Promise<T> =>
  runInDurableObject(storeOf(userId), (_instance, state) => read(tenantStoreOf(state.storage)));

const caller = (userId: string) => ({ userId, deviceId: "device-1", name: "laptop", host: "laptop" });

const session = {
  host: "laptop",
  cwd: "/home/you/src/recall",
  repo: "repo:github.com/mvhenten/recall",
  branch: "main",
  commit: "feat(store): serve a tenant's rows from its own object",
  startedAt: 1_700_000_000_000,
  lastActivityAt: 1_700_000_060_000,
  prompts: 3,
  focus: { first: "move the tenant half", latest: "move the tenant half" },
  mode: "interactive" as const,
  permissionMode: "default",
  pid: 4242,
};

// What a history row carries that the index reads, for one fixed corpus. The same rows go into the
// tenant object and into D1, and the ranking the reader returns is held against the ranking the
// query itself produces over the same corpus.
const CORPUS: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["s-1", "rank the chunks a search reads", "bound the vector scan", "feat(search): bound the vector scan", "cobalt"],
  ["s-2", "bound the vector scan", "rank the history rows", "fix(rank): rank the history rows", "nimbus"],
  ["s-3", "move the board into the object", "rank the board", "feat(board): rank the board", "cobalt"],
  ["s-4", "write the migration", "write the migration once", "chore(store): write the migration", "slate"],
  ["s-5", "scan the archive", "scan the archive twice", "fix(index): scan the archive", "nimbus"],
];

const QUERIES = ["rank", "scan", "cobalt", "board OR migration", "vector AND scan"];

const HISTORY_INSERT = `INSERT INTO session_history (user_id, session_id, device_id, device_name, host, cwd, repo,
   branch, commit_subject, started_at, last_activity_at, prompts, focus_first, focus_latest, mode, agent_name)
 VALUES (?1, ?2, 'device-1', 'laptop', 'laptop', '/x', 'repo', 'main', ?5, 1, 2, 3, ?3, ?4, 'interactive', ?6)`;

const HISTORY_RANKING = `SELECT h.session_id FROM session_history h
   JOIN session_history_fts f ON f.session_id = h.session_id AND f.user_id = h.user_id
   WHERE session_history_fts MATCH ?2 AND h.user_id = ?1
   ORDER BY bm25(session_history_fts) LIMIT 10`;

const FILTER: HistoryInput = { host: "", repo: "", cursor: "", limit: 10, sort: "", query: "" };

const NOW = 1_700_000_120_000;

// The prose one session's chunks hold, for the same corpus in both stores. `session_chunks_fts` is
// an external-content table: it holds no copy of a chunk and its terms are the insert trigger's to
// write, so a store that carried the table and lost the trigger ranks nothing at all.
const CHUNKS: ReadonlyArray<readonly [number, string, string, string]> = [
  [1, "s-1", "user", "rank the chunks a search reads before it bounds the vector scan"],
  [2, "s-1", "model", "the vector scan is bounded by the chunks the search ranks"],
  [3, "s-2", "user", "move the board into the object and rank the board"],
  [4, "s-3", "model", "write the migration once and scan the archive twice"],
  [5, "s-3", "user", "scan the archive for a migration it never wrote"],
];

const CHUNK_QUERIES = ["rank", "scan", "board OR migration", "vector AND scan", "archive"];

const CHUNK_INSERT = `INSERT INTO session_chunks (chunk_seq, user_id, session_id, ordinal, speaker, text, embedding, at)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)`;

const CHUNK_RANKING = `SELECT c.chunk_seq FROM session_chunks_fts f
   JOIN session_chunks c ON c.chunk_seq = f.rowid
   WHERE session_chunks_fts MATCH ?2 AND c.user_id = ?1
   ORDER BY bm25(session_chunks_fts) LIMIT 10`;

const EMBEDDING = new ArrayBuffer(4);

// What an artifact carries that the shelf's index reads. `artifacts_fts` is external-content over
// `artifacts` and its terms are the insert trigger's to write, so the corpus goes into D1's copy
// of the table and into the tenant object's, and the two rankings are held against each other.
const ARTIFACTS: ReadonlyArray<readonly [string, string, string]> = [
  ["rank-the-shelf", "bound the vector scan", "a shelf ranks the artifacts it holds"],
  ["bound-the-shelf", "rank the shelf rows", "the shelf is bounded before it is drawn"],
  ["board-deck", "rank the board", "the board deck moves into the object"],
  ["migration-notes", "write it once", "the migration is written once"],
  ["archive-report", "scan the shelf", "the archive is scanned and ranked"],
];

// name heaviest, then title, then description — the column order `artifacts_fts` was created in.
const ARTIFACT_RANKING = `SELECT a.name FROM artifacts_fts f
   JOIN artifacts a ON a.artifact_seq = f.rowid
   WHERE artifacts_fts MATCH ?2 AND a.user_id = ?1
   ORDER BY bm25(artifacts_fts, 5.0, 2.0, 1.0) LIMIT 51`;

const ARTIFACT_QUERIES = ["rank", "scan", "archive", "board OR migration", "vector AND scan"];

const ARTIFACT_INSERT = `INSERT INTO artifacts (user_id, name, rev, type, title, description, read_perm,
   write_perm, entry_path, files, file_count, bytes, created_at, updated_at, last_writer_user_id)
 VALUES (?1, ?2, 1, 'document', ?3, ?4, 'private', 'owner', 'index.md', '[]', 1, 12, 1, 1, ?1)`;

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

const MEMORY_QUERIES = ["rank", "scan", "archive", "board OR migration", "vector AND scan"];

const SAVED_AT = 1_700_000_000_000;

const embeddingFor = (name: string): Uint8Array =>
  Uint8Array.from({ length: 16 }, (_, index) => (name.charCodeAt(index % name.length) + index) % 256);

const withMemories = async (): Promise<string> => {
  const userId = `user-${crypto.randomUUID()}`;
  for (const [name, description, body, tag] of MEMORIES) {
    await inStore(userId, (db) =>
      saveMemory(db, userId, name, { description, type: "project", body, tags: [tag] }, embeddingFor(name), SAVED_AT),
    );
  }
  return userId;
};

describe("the tenant store", () => {
  it("takes a whole batch back when one statement of it fails", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const outcome = await runInDurableObject(storeOf(userId), async (_instance, state) => {
      const db = tenantStoreOf(state.storage);
      const write = (): void => {
        db.transaction((tx) => {
          // The third statement collides with the first on the primary key, which is how a batch
          // is made to fail past its opening statement.
          for (const value of ["laptop", "tower", "laptop"]) {
            tx.insert(labels)
              .values({ userId, kind: "host", value, label: `label-${value}` })
              .run();
          }
        });
      };
      const refused = await Promise.resolve()
        .then(write)
        .then(() => "")
        .catch((failure: unknown) => (failure instanceof Error ? failure.message : String(failure)));
      return { refused, left: db.select().from(labels).where(eq(labels.userId, userId)).all().length };
    });
    expect(outcome.refused).toContain("UNIQUE constraint failed");
    expect(outcome.left).toBe(0);
  });

  it("counts the rows a write changed, so a session ends exactly once", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const answered = await runInDurableObject(storeOf(userId), async (_instance, state) => {
      const db = tenantStoreOf(state.storage);
      await putSession(db, caller(userId), "s-1", session, 1_700_000_060_000);
      const first = await endSession(db, userId, "s-1");
      const again = await endSession(db, userId, "s-1");
      const missing = await endSession(db, userId, "s-never");
      return { first, again, missing };
    });
    expect(answered).toEqual({ first: true, again: false, missing: false });
  });

  it("lays its schema down once however many requests reach it", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const first = await tenantRows<{ name: string; applied_at: number }>(
      userId,
      "SELECT name, applied_at FROM __migrations ORDER BY name",
    );
    expect(first.map((row) => row.name)).toEqual(TENANT_MIGRATIONS.map((migration) => migration.name));
    await tenantRows(
      userId,
      "INSERT INTO labels (user_id, kind, value, label) VALUES (?, 'host', ?, ?)",
      userId,
      "a",
      "b",
    );
    // The object is torn down and built again, so the constructor runs its migration a second time
    // against a store that is already current. A migration that ran again would fail outright on
    // `CREATE TABLE sessions`, and one that ran as a no-op would still stamp a new row.
    await evictDurableObject(storeOf(userId));
    const second = await tenantRows<{ name: string; applied_at: number }>(
      userId,
      "SELECT name, applied_at FROM __migrations ORDER BY name",
    );
    expect(second).toEqual(first);
    expect(await tenantRows(userId, "SELECT value FROM labels")).toEqual([{ value: "a" }]);
  });

  it("ranks a history search the way bm25 ranks it", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    for (const [sessionId, first, latest, subject, agent] of CORPUS) {
      await env.DB.prepare(HISTORY_INSERT).bind(userId, sessionId, first, latest, subject, agent).run();
      await tenantRows(userId, HISTORY_INSERT, userId, sessionId, first, latest, subject, agent);
    }
    for (const query of QUERIES) {
      const { results } = await env.DB.prepare(HISTORY_RANKING).bind(userId, query).all<{ session_id: string }>();
      const ranked = results.map((row) => row.session_id);
      const object = await inStore(userId, (db) => searchSessionHistory(db, userId, FILTER, query, FILTER.limit, NOW));
      expect(ranked).not.toEqual([]);
      expect(object.sessions.map((found) => found.sessionId)).toEqual(ranked);
    }
  });

  it("ranks an artifact search the way bm25 weights it", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    for (const [name, title, description] of ARTIFACTS) {
      await env.DB.prepare(ARTIFACT_INSERT).bind(userId, name, title, description).run();
      const written = await inStore(userId, (db) =>
        createArtifact(db, {
          userId,
          name,
          rev: 1,
          type: "document",
          title,
          description,
          read: "private",
          write: "owner",
          files: [{ path: "index.md", bytes: 12, contentType: "text/markdown" }],
          at: NOW,
          writer: "someone@example.com",
        }),
      );
      expect(written).toBe(true);
    }
    for (const query of ARTIFACT_QUERIES) {
      const { results } = await env.DB.prepare(ARTIFACT_RANKING).bind(userId, query).all<{ name: string }>();
      const ranked = results.map((row) => row.name);
      expect(ranked).not.toEqual([]);
      const found = await inStore(userId, (db) => searchArtifacts(db, userId, "", query, 50));
      expect(found.artifacts.map((artifact) => artifact.name)).toEqual(ranked);
    }
  });

  it("ranks a memory search by tag scope first and then the way bm25 weights it", async () => {
    const userId = await withMemories();
    for (const query of MEMORY_QUERIES) {
      const ranked = (await tenantRows<{ memory_id: string }>(userId, MEMORY_RANKING, userId, query, "search")).map(
        (row) => row.memory_id,
      );
      expect(ranked, query).not.toEqual([]);
      const found = await inStore(userId, (db) => textCandidates(db, userId, ["search"], [], query));
      expect(found.map((candidate) => candidate.memoryId)).toEqual(ranked);
      const scope = found.map((candidate) => candidate.inScope);
      expect(scope).toEqual([...scope].sort((left, right) => Number(right) - Number(left)));
    }
  });

  // The object's SQLite hands a blob back as an ArrayBuffer and a miniflare build of D1 as a
  // number array, so this is the one read that proves a vector survives the round trip byte for
  // byte whichever of the two the driver gives.
  it("hands an embedding back as the bytes it was saved with", async () => {
    const userId = await withMemories();
    const candidates = await inStore(userId, (db) => vectorCandidates(db, userId, [], []));
    expect(candidates).toHaveLength(MEMORIES.length);
    const byId = new Map(candidates.map((candidate) => [candidate.memoryId, [...candidate.embedding]]));
    for (const [name] of MEMORIES) {
      const saved = await inStore(userId, (db) => getMemory(db, userId, name));
      expect(saved).not.toBeNull();
      expect(byId.get(saved?.memoryId ?? "")).toEqual([...embeddingFor(name)]);
    }
  });

  it("ranks a chunk search the way bm25 ranks it", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    for (const [chunkSeq, sessionId, speaker, text] of CHUNKS) {
      await env.DB.prepare(CHUNK_INSERT).bind(chunkSeq, userId, sessionId, chunkSeq, speaker, text, EMBEDDING).run();
      await tenantRows(userId, CHUNK_INSERT, chunkSeq, userId, sessionId, chunkSeq, speaker, text, EMBEDDING);
    }
    for (const query of CHUNK_QUERIES) {
      const { results } = await env.DB.prepare(CHUNK_RANKING).bind(userId, query).all<{ chunk_seq: number }>();
      const ranked = results.map((row) => row.chunk_seq);
      const object = await inStore(userId, (db) => chunkMatches(db, userId, query, 10));
      expect(ranked).not.toEqual([]);
      expect(object.map((found) => found.chunkSeq)).toEqual(ranked);
    }
  });
});
