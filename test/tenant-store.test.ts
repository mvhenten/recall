import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { endSession, putSession } from "../src/store";
import { tenantSql } from "../src/tenant-sql";
import { tenantRows } from "./harness";

const storeOf = (userId: string) => env.TENANT.get(env.TENANT.idFromName(userId));

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

const RANKED = `SELECT h.session_id FROM session_history h
   JOIN session_history_fts f ON f.session_id = h.session_id AND f.user_id = h.user_id
   WHERE session_history_fts MATCH ?2 AND h.user_id = ?1
   ORDER BY bm25(session_history_fts), h.session_id`;

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
      const d1 = await env.DB.prepare(RANKED).bind(userId, query).all<{ session_id: string }>();
      const object = await tenantRows<{ session_id: string }>(userId, RANKED, userId, query);
      expect(d1.results.map((row) => row.session_id)).not.toEqual([]);
      expect(object.map((row) => row.session_id)).toEqual(d1.results.map((row) => row.session_id));
    }
  });
});
