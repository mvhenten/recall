import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { quantize } from "../src/rank";
import type { SessionCopyReport } from "../src/session-copy";
import { type Client, harness, tenantRows, wordEmbedder } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

const AT = 1_700_000_000_000;

const INSERT_SESSION = `INSERT INTO sessions (user_id, session_id, device_id, device_name, host, cwd, repo, branch,
   commit_subject, started_at, last_activity_at, prompts, focus_first, focus_latest, mode, permission_mode, pid,
   agent_name)
 VALUES (?1, ?2, 'device-d1', 'laptop', 'laptop', '/home/you/src/recall', 'repo:recall', 'main', 'feat: ship it',
   ?3, ?3, 3, ?4, ?4, 'interactive', 'default', 4242, '')`;

const INSERT_HISTORY = `INSERT INTO session_history (user_id, session_id, device_id, device_name, host, cwd, repo,
   branch, commit_subject, started_at, last_activity_at, prompts, focus_first, focus_latest, mode, agent_name)
 VALUES (?1, ?2, 'device-d1', 'laptop', 'laptop', '/home/you/src/recall', 'repo:recall', 'main', 'feat: ship it',
   ?3, ?3, 3, ?4, ?4, 'interactive', '')`;

const INSERT_MARK =
  "INSERT INTO session_index (user_id, session_id, archived, bytes, chunks) VALUES (?1, ?2, ?3, ?3, ?4)";

const INSERT_CHUNK = `INSERT INTO session_chunks (user_id, session_id, ordinal, speaker, text, embedding, at)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

const INSERT_RECORD =
  "INSERT INTO session_records (user_id, session_id, file, next_ordinal) VALUES (?1, ?2, 'main', 91)";

const INSERT_LABEL = "INSERT INTO labels (user_id, kind, value, label) VALUES (?1, 'host', 'laptop', 'the laptop')";

const INSERT_USAGE = `INSERT INTO usage_events (user_id, session_id, seq, provider, account, model, prompts,
   input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, at, recorded_at)
 VALUES (?1, ?2, 1, 'anthropic', 'max', 'opus', 3, 900, 120, 40, 7, ?3, ?3)`;

const INSERT_DAY = `INSERT INTO usage_daily (user_id, day, host, repo, account, provider, model, prompts,
   input_tokens, output_tokens, cache_write_tokens, cache_read_tokens)
 VALUES (?1, '2026-10-19', 'laptop', 'repo:recall', 'max', 'anthropic', 'opus', 3, 900, 120, 40, 7)`;

// What the account said in the sessions that were archived before they moved. Each chunk carries a
// word of its own, so a search run over the copy says which chunk answered it.
const PROSE: ReadonlyArray<readonly ["user" | "model", string]> = [
  ["user", "rebuild the archive reader so a transcript opens at the turn it was asked about"],
  ["model", "the reader streams the gzip members and inflates them in the browser"],
  ["user", "why does the indexer skip a stretch when the notification never arrives"],
  ["model", "nothing sweeps for a session whose last event was lost, so it stays short"],
];

const embeddingFor = async (text: string): Promise<Uint8Array> => {
  const [vector] = await wordEmbedder.embed([text]);
  if (vector === undefined) throw new Error("the embedder answered no vector");
  return quantize(vector);
};

// One session exactly as the Worker left it in D1: the session document, its history row, its
// index mark and the chunks of its prose. Nothing writes this layout any more, so a test of the
// copy has to lay it down itself.
const seedSession = async (userId: string, sessionId: string, focus: string, live: boolean): Promise<void> => {
  if (live) await env.DB.prepare(INSERT_SESSION).bind(userId, sessionId, AT, focus).run();
  await env.DB.prepare(INSERT_HISTORY).bind(userId, sessionId, AT, focus).run();
  await env.DB.prepare(INSERT_MARK).bind(userId, sessionId, 4096, PROSE.length).run();
  for (const [ordinal, [speaker, text]] of PROSE.entries()) {
    const embedding = await embeddingFor(text);
    await env.DB.prepare(INSERT_CHUNK)
      .bind(userId, sessionId, ordinal, speaker, text, embedding.slice().buffer, AT + ordinal)
      .run();
  }
};

interface D1Chunk {
  chunk_seq: number;
  session_id: string;
  ordinal: number;
  text: string;
}

const accountChunks = async (userId: string): Promise<D1Chunk[]> => {
  const { results } = await env.DB.prepare(
    "SELECT chunk_seq, session_id, ordinal, text FROM session_chunks WHERE user_id = ?1 ORDER BY chunk_seq",
  )
    .bind(userId)
    .all<D1Chunk>();
  return results;
};

const tenantChunks = (userId: string): Promise<D1Chunk[]> =>
  tenantRows<D1Chunk>(
    userId,
    "SELECT chunk_seq, session_id, ordinal, text FROM session_chunks WHERE user_id = ?1 ORDER BY chunk_seq",
    userId,
  );

const copy = async (client: Client): Promise<SessionCopyReport> => {
  const response = await client.request("POST", "/v1/sessions/copy");
  expect(response.status).toBe(200);
  return response.json();
};

const owner = async (h: Harness): Promise<Client> => h.user("copy-sessions");

describe("copying the sessions an account held before they moved", () => {
  it("brings every row over under the sequence its search index ranks by", async () => {
    const h = await harness();
    const client = await owner(h);
    const live = crypto.randomUUID();
    const over = crypto.randomUUID();
    await seedSession(client.userId, live, "rebuild the archive reader", true);
    await seedSession(client.userId, over, "why the indexer skips a stretch", false);
    await env.DB.prepare(INSERT_RECORD).bind(client.userId, over).run();
    await env.DB.prepare(INSERT_LABEL).bind(client.userId).run();
    await env.DB.prepare(INSERT_USAGE).bind(client.userId, live, AT).run();
    await env.DB.prepare(INSERT_DAY).bind(client.userId).run();
    expect((await client.session(live)).status).toBe(404);

    const report = await copy(client);
    expect(report.sessions).toEqual({ copied: 1, held: 0 });
    expect(report.history).toEqual({ copied: 2, held: 0 });
    expect(report.index).toEqual({ copied: 2, held: 0 });
    expect(report.records).toEqual({ copied: 1, held: 0 });
    expect(report.usageEvents).toEqual({ copied: 1, held: 0 });
    expect(report.usageDaily).toEqual({ copied: 1, held: 0 });
    expect(report.labels).toEqual({ copied: 1, held: 0 });
    expect(report.chunks).toEqual({ copied: PROSE.length * 2, held: 0, shifted: 0, moved: 0 });
    expect(report.straddling).toEqual([]);
    expect(report.checks.missing).toEqual([]);
    expect(report.checks.extra).toEqual([]);
    expect(report.checks.missingChunks).toBe(0);
    expect(report.checks.embeddings).toEqual([]);
    expect(report.checks.chunkIndex).toBe("");
    expect(report.checks.historyIndex).toBe("");
    expect(report.checks.ok).toBe(true);

    // Every chunk kept the key D1 wrote it under, which is what `session_chunks_fts` ranks by and
    // what the vector scan reads as recency.
    expect(await tenantChunks(client.userId)).toEqual(await accountChunks(client.userId));

    expect((await client.session(live)).status).toBe(200);
    const history = await client.request("GET", "/v1/sessions?scope=history");
    const page: { sessionIds: string[] } = await history.json();
    expect(page.sessionIds.sort()).toEqual([live, over].sort());

    const found = await client.searchSessions("indexer skip stretch notification");
    expect(found.status).toBe(200);
    const hits: { hits: Array<{ session: { sessionId: string }; excerpt: { text: string } }> } = await found.json();
    expect(hits.hits.map((hit) => hit.session.sessionId)).toContain(over);
  });

  it("copies nothing the second time and writes no second row or chunk", async () => {
    const h = await harness();
    const client = await owner(h);
    const sessionId = crypto.randomUUID();
    await seedSession(client.userId, sessionId, "rebuild the archive reader", true);
    await copy(client);
    const after = await tenantChunks(client.userId);

    const again = await copy(client);
    expect(again.sessions).toEqual({ copied: 0, held: 1 });
    expect(again.history).toEqual({ copied: 0, held: 1 });
    expect(again.index).toEqual({ copied: 0, held: 1 });
    expect(again.chunks).toEqual({ copied: 0, held: PROSE.length, shifted: 0, moved: 0 });
    expect(again.checks.chunkIndex).toBe("");
    expect(again.checks.ok).toBe(true);
    expect(await tenantChunks(client.userId)).toEqual(after);
  });

  // The three sessions that straddle the cutover. The object wrote its own prose for one of them
  // after the deployment, under ordinals that start at zero again and a `chunk_seq` D1 had already
  // handed out — so the object's chunk moves up, its index entry moves by hand with it, and the
  // copied chunks climb past the ordinals it holds rather than being dropped on them.
  it("keeps the object's own session and lifts its chunks above the ones D1 hands over", async () => {
    const h = await harness();
    const client = await owner(h);
    const sessionId = crypto.randomUUID();
    await seedSession(client.userId, sessionId, "rebuild the archive reader", true);
    const before = await accountChunks(client.userId);
    const lowest = before[0]?.chunk_seq;
    if (lowest === undefined) throw new Error("the seed wrote no chunk");

    expect(
      (await client.sync(sessionId, { focus: { first: "what the host says now", latest: "ship the reader" } })).status,
    ).toBe(204);
    const own = "the dashboard draws a sparkline per repository";
    await tenantRows(
      client.userId,
      "INSERT INTO session_chunks (chunk_seq, user_id, session_id, ordinal, speaker, text, embedding, at) VALUES (?1, ?2, ?3, 0, 'model', ?4, ?5, ?6)",
      lowest,
      client.userId,
      sessionId,
      own,
      (await embeddingFor(own)).slice().buffer,
      AT,
    );

    const report = await copy(client);
    expect(report.straddling).toEqual([sessionId]);
    expect(report.sessions).toEqual({ copied: 0, held: 1 });
    expect(report.chunks.copied).toBe(PROSE.length);
    expect(report.chunks.moved).toBe(1);
    expect(report.chunks.shifted).toBeGreaterThan(0);
    // SQLite's own read of the index the move hand-wrote: no entry left at the rowid the mover
    // vacated, and the one it moved to is there.
    expect(report.checks.chunkIndex).toBe("");
    expect(report.checks.missingChunks).toBe(0);
    expect(report.checks.embeddings).toEqual([]);
    expect(report.checks.ok).toBe(true);

    // The object's row stands: it is the later of the two and the copy does not write over it.
    const held = await tenantRows<{ focus_first: string }>(
      client.userId,
      "SELECT focus_first FROM sessions WHERE user_id = ?1 AND session_id = ?2",
      client.userId,
      sessionId,
    );
    expect(held[0]?.focus_first).toBe("what the host says now");

    // Every chunk D1 held arrived under its own key, and the object's own sits above all of them.
    const copied = await tenantChunks(client.userId);
    expect(copied.filter((row) => row.text !== own).map((row) => [row.chunk_seq, row.text])).toEqual(
      before.map((row) => [row.chunk_seq, row.text]),
    );
    const mover = copied.find((row) => row.text === own);
    expect(mover?.chunk_seq).toBeGreaterThan(Math.max(...before.map((row) => row.chunk_seq)));

    // The ordinals are a set, not a sequence with a hole in it, and the mark says where the next
    // pass of either indexing path opens.
    expect(copied.map((row) => row.ordinal).sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4]);
    const mark = await tenantRows<{ chunks: number }>(
      client.userId,
      "SELECT chunks FROM session_index WHERE user_id = ?1 AND session_id = ?2",
      client.userId,
      sessionId,
    );
    expect(mark[0]?.chunks).toBe(copied.length);

    // The moved chunk is still the one its own words find, which is what says its index entry
    // moved with it rather than being left under a rowid a copied chunk now answers to.
    const matched = await tenantRows<{ chunk_seq: number }>(
      client.userId,
      "SELECT rowid AS chunk_seq FROM session_chunks_fts WHERE session_chunks_fts MATCH 'sparkline'",
    );
    expect(matched.map((row) => row.chunk_seq)).toEqual([mover?.chunk_seq]);
  });
});
