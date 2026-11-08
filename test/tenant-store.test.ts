import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { HistoryInput } from "../src/model";
import { chunkMatches, endSession, putSession, searchSessionHistory } from "../src/store";
import { type SqlDb, tenantSql } from "../src/tenant-sql";
import { tenantRows } from "./harness";

const storeOf = (userId: string) => env.TENANT.get(env.TENANT.idFromName(userId));

// One account's own store, handed to the shipped reader as the tenant object hands it over.
const inStore = <T>(userId: string, read: (db: SqlDb) => Promise<T>): Promise<T> =>
  runInDurableObject(storeOf(userId), (_instance, state) => read(tenantSql(state.storage)));

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

// What a history row carries that the index reads, for one fixed corpus. The same rows go into D1
// and into a tenant object, and the two are asked the same questions.
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

const EMBEDDING = new ArrayBuffer(4);

describe("the tenant store", () => {
  it("takes a whole batch back when one statement of it fails", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const outcome = await runInDurableObject(storeOf(userId), async (_instance, state) => {
      const db = tenantSql(state.storage);
      const label = (value: string) =>
        db
          .prepare("INSERT INTO labels (user_id, kind, value, label) VALUES (?1, 'host', ?2, ?3)")
          .bind(userId, value, `label-${value}`);
      // The second statement collides with the first on the primary key, which is how a batch is
      // made to fail past its opening statement.
      const refused = await db
        .batch([label("laptop"), label("tower"), label("laptop")])
        .then(() => "")
        .catch((failure: unknown) => (failure instanceof Error ? failure.message : String(failure)));
      const [left] = await db
        .prepare("SELECT COUNT(*) AS n FROM labels")
        .all<{ n: number }>()
        .then((it) => it.results);
      return { refused, left: left?.n };
    });
    expect(outcome.refused).toContain("UNIQUE constraint failed");
    expect(outcome.left).toBe(0);
  });

  it("counts the rows a write changed, so a session ends exactly once", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const answered = await runInDurableObject(storeOf(userId), async (_instance, state) => {
      const db = tenantSql(state.storage);
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
    expect(first).toHaveLength(1);
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

  it("ranks a history search the way D1 ranks it", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    for (const [sessionId, first, latest, subject, agent] of CORPUS) {
      await env.DB.prepare(HISTORY_INSERT).bind(userId, sessionId, first, latest, subject, agent).run();
      await tenantRows(userId, HISTORY_INSERT, userId, sessionId, first, latest, subject, agent);
    }
    for (const query of QUERIES) {
      const d1 = await searchSessionHistory(env.DB, userId, FILTER, query, FILTER.limit, NOW);
      const object = await inStore(userId, (db) => searchSessionHistory(db, userId, FILTER, query, FILTER.limit, NOW));
      expect(d1.sessions).not.toEqual([]);
      expect(object).toEqual(d1);
    }
  });

  it("ranks a chunk search the way D1 ranks it", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    for (const [chunkSeq, sessionId, speaker, text] of CHUNKS) {
      await env.DB.prepare(CHUNK_INSERT).bind(chunkSeq, userId, sessionId, chunkSeq, speaker, text, EMBEDDING).run();
      await tenantRows(userId, CHUNK_INSERT, chunkSeq, userId, sessionId, chunkSeq, speaker, text, EMBEDDING);
    }
    for (const query of CHUNK_QUERIES) {
      const d1 = await chunkMatches(env.DB, userId, query, 10);
      const object = await inStore(userId, (db) => chunkMatches(db, userId, query, 10));
      expect(d1).not.toEqual([]);
      expect(object).toEqual(d1);
    }
  });
});
