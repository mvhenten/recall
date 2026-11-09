import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { quantize } from "../src/rank";
import { rowName } from "../src/row-digest";
import { legacySessions } from "../src/schema/legacy";
import { sessions } from "../src/schema/tenant";
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

const INSERT_COUNTED = "INSERT INTO counted_files (user_id, session_id, file) VALUES (?1, ?2, 'main')";

const INSERT_OPEN_CHUNK = `INSERT INTO session_open_chunks (user_id, session_id, file, speaker, pieces, at)
 VALUES (?1, ?2, 'main', 'user', '["half a turn the last append left open"]', ?3)`;

const INSERT_BOARD = `INSERT INTO board_messages (user_id, message_id, scope, target, from_device_id, from_host,
   from_name, body, created_at, expires_at)
 VALUES (?1, ?2, 'fleet', ?1, 'device-d1', 'laptop', 'laptop', 'read the archive before you rebuild it', ?3, ?4)`;

const INSERT_PICKUP = `INSERT INTO board_pickups (user_id, message_id, session_id, device_id, host, picked_up_at)
 VALUES (?1, ?2, ?3, 'device-d1', 'laptop', ?4)`;

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

const copyFrom = async (client: Client, after: number, metadataComplete = false): Promise<SessionCopyReport> => {
  const response = await client.request("POST", "/v2/sessions/copy", { after, metadataComplete });
  expect(response.status).toBe(200);
  const report: SessionCopyReport = await response.json();
  // Every corpus a test writes is well inside one call's budget, so a run that did not reach the
  // end of the prose is this harness and not the copy.
  expect(report.chunks.done).toBe(true);
  return report;
};

const copy = (client: Client): Promise<SessionCopyReport> => copyFrom(client, 0);

const tallyOf = (report: SessionCopyReport, table: string): { stored: number; alreadyStored: number } => {
  const row = report.tables.find((one) => one.table === table);
  if (row === undefined) throw new Error(`the report names no table ${table}`);
  return { stored: row.stored, alreadyStored: row.alreadyStored };
};

// Every row D1 holds that the object does not, across every table, which is what the copy now
// answers with rather than leaving to a count.
const blockedOf = (report: SessionCopyReport): string[] =>
  report.tables.flatMap((row) => row.blockedIds.map((rowId) => `${row.table}/${rowId}`));

const collidedOf = (report: SessionCopyReport): string[] =>
  report.tables.flatMap((row) => row.collidedIds.map((rowId) => `${row.table}/${rowId}`));

const owner = async (h: Harness): Promise<Client> => h.user("copy-sessions");

describe("copying the sessions an account held before they moved", () => {
  it("brings every row over under the sequence its search index ranks by", async () => {
    const h = await harness();
    const client = await owner(h);
    const live = crypto.randomUUID();
    const over = crypto.randomUUID();
    await seedSession(client.userId, live, "rebuild the archive reader", true);
    await seedSession(client.userId, over, "why the indexer skips a stretch", false);
    const messageId = crypto.randomUUID();
    await env.DB.prepare(INSERT_RECORD).bind(client.userId, over).run();
    await env.DB.prepare(INSERT_LABEL).bind(client.userId).run();
    await env.DB.prepare(INSERT_USAGE).bind(client.userId, live, AT).run();
    await env.DB.prepare(INSERT_DAY).bind(client.userId).run();
    await env.DB.prepare(INSERT_COUNTED).bind(client.userId, over).run();
    await env.DB.prepare(INSERT_OPEN_CHUNK).bind(client.userId, live, AT).run();
    await env.DB.prepare(INSERT_BOARD)
      .bind(client.userId, messageId, AT, AT + 604_800_000)
      .run();
    await env.DB.prepare(INSERT_PICKUP).bind(client.userId, messageId, live, AT).run();
    expect((await client.session(live)).status).toBe(404);

    const report = await copy(client);
    expect(tallyOf(report, "Sessions")).toEqual({ stored: 1, alreadyStored: 0 });
    expect(tallyOf(report, "History")).toEqual({ stored: 2, alreadyStored: 0 });
    expect(tallyOf(report, "Index")).toEqual({ stored: 2, alreadyStored: 0 });
    expect(tallyOf(report, "Records")).toEqual({ stored: 1, alreadyStored: 0 });
    expect(tallyOf(report, "OpenChunks")).toEqual({ stored: 1, alreadyStored: 0 });
    expect(tallyOf(report, "CountedFiles")).toEqual({ stored: 1, alreadyStored: 0 });
    expect(tallyOf(report, "UsageEvents")).toEqual({ stored: 1, alreadyStored: 0 });
    expect(tallyOf(report, "UsageDaily")).toEqual({ stored: 1, alreadyStored: 0 });
    expect(tallyOf(report, "Labels")).toEqual({ stored: 1, alreadyStored: 0 });
    expect(tallyOf(report, "BoardMessages")).toEqual({ stored: 1, alreadyStored: 0 });
    expect(tallyOf(report, "BoardPickups")).toEqual({ stored: 1, alreadyStored: 0 });
    expect(tallyOf(report, "Chunks")).toEqual({ stored: PROSE.length * 2, alreadyStored: 0 });
    expect(report.chunks.shifted).toBe(0);
    expect(report.chunks.moved).toBe(0);
    expect(report.straddling).toEqual([]);
    expect(report.checks.missing).toEqual([]);
    expect(report.checks.extra).toEqual([]);
    expect(report.checks.missingChunks).toBe(0);
    expect(report.checks.embeddings).toEqual([]);
    expect(report.checks.chunkIndex).toEqual({ state: "Sound" });
    expect(report.checks.historyIndex).toEqual({ state: "Sound" });
    expect(report.checks.ok).toBe(true);

    // Every row D1 holds was answered for by its id, and none was blocked by another row standing
    // where it belongs. That is the proof a count cannot give: a table whose every insert
    // conflicted holds as many rows as D1 does and reads as copied twice over.
    expect(blockedOf(report)).toEqual([]);
    expect(collidedOf(report)).toEqual([]);

    // How each table was read, which is what a row that did not cross would mean for it. The
    // seven the object's own row wins on are read by what identifies the row; the four nothing
    // rewrites by the whole of it; the prose by its own walk.
    expect(report.tables.map((row) => [row.table, row.identity])).toEqual([
      ["Sessions", "Key"],
      ["History", "Key"],
      ["Index", "Key"],
      ["Records", "Key"],
      ["OpenChunks", "Key"],
      ["UsageDaily", "Key"],
      ["Labels", "Key"],
      ["CountedFiles", "WholeRow"],
      ["UsageEvents", "WholeRow"],
      ["BoardMessages", "WholeRow"],
      ["BoardPickups", "WholeRow"],
      ["Chunks", "Walked"],
    ]);

    // Every chunk kept the key D1 wrote it under, which is what `session_chunks_fts` ranks by and
    // what the vector scan reads as recency.
    expect(await tenantChunks(client.userId)).toEqual(await accountChunks(client.userId));

    // The rows no session page reads, which arrive or do not and only a count would say.
    const kept = await tenantRows<{ counted: number; open: number; posted: number; taken: number; labelled: number }>(
      client.userId,
      `SELECT (SELECT count(*) FROM counted_files WHERE user_id = ?1) AS counted,
         (SELECT count(*) FROM session_open_chunks WHERE user_id = ?1) AS open,
         (SELECT count(*) FROM board_messages WHERE user_id = ?1) AS posted,
         (SELECT count(*) FROM board_pickups WHERE user_id = ?1) AS taken,
         (SELECT count(*) FROM labels WHERE user_id = ?1) AS labelled`,
      client.userId,
    );
    expect(kept).toEqual([{ counted: 1, open: 1, posted: 1, taken: 1, labelled: 1 }]);

    expect((await client.session(live)).status).toBe(200);
    const history = await client.request("GET", "/v2/history");
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
    expect(tallyOf(again, "Sessions")).toEqual({ stored: 0, alreadyStored: 1 });
    expect(tallyOf(again, "History")).toEqual({ stored: 0, alreadyStored: 1 });
    expect(tallyOf(again, "Index")).toEqual({ stored: 0, alreadyStored: 1 });
    expect(tallyOf(again, "Chunks")).toEqual({ stored: 0, alreadyStored: PROSE.length });
    expect(again.chunks.shifted).toBe(0);
    expect(again.chunks.moved).toBe(0);
    expect(again.checks.chunkIndex).toEqual({ state: "Sound" });
    expect(again.checks.ok).toBe(true);
    expect(await tenantChunks(client.userId)).toEqual(after);

    // A call told a call of its own run already wrote the metadata leaves it alone rather than
    // reading every table of D1 and attempting an insert per row again: `usage_events` is one row
    // per event of every session the account ever ran, and doing that on each of a long run's
    // calls would spend the budget re-conflicting what the opening call already wrote. No row was
    // offered, so none was answered for; the counts beside that are still taken.
    const carried = await copyFrom(client, after[0]?.chunk_seq ?? 1, true);
    for (const row of carried.tables) {
      if (row.table === "Chunks") continue;
      expect([row.table, row.stored, row.alreadyStored, row.blocked]).toEqual([row.table, 0, 0, 0]);
      expect([row.table, row.inTenant >= row.inAccount]).toEqual([row.table, true]);
    }
    expect(await tenantChunks(client.userId)).toEqual(after);
  });

  // The call that opens a run writes the metadata whatever it is told about the prose, because
  // nothing the object holds can say whether an earlier call got through it. The object writes its
  // own rows into these tables after the cutover, so one it has outgrown D1 on answers
  // `tenant >= account` having never been copied into — and a continuation reading that as done
  // would leave every row of it in D1 while the run reported itself verified.
  it("writes the metadata on an opening call against a table the object has outgrown", async () => {
    const h = await harness();
    const client = await owner(h);
    const sessionId = crypto.randomUUID();
    const mine = crypto.randomUUID();
    await seedSession(client.userId, sessionId, "rebuild the archive reader", true);
    await env.DB.prepare(INSERT_COUNTED).bind(client.userId, sessionId).run();
    // What the object counted for itself since the cutover, which outnumbers the one row D1 holds.
    for (const file of ["main", "agent-a", "agent-b"]) {
      await tenantRows(
        client.userId,
        "INSERT INTO counted_files (user_id, session_id, file) VALUES (?1, ?2, ?3)",
        client.userId,
        mine,
        file,
      );
    }

    // An opening call, however far along the prose it is told to start: the metadata is written.
    const opened = await copyFrom(client, 99_999_999);
    expect(tallyOf(opened, "CountedFiles")).toEqual({ stored: 1, alreadyStored: 0 });
    expect(opened.metadataComplete).toBe(true);
    const counted = await tenantRows<{ n: number }>(
      client.userId,
      "SELECT count(*) AS n FROM counted_files WHERE user_id = ?1",
      client.userId,
    );
    expect(counted[0]?.n).toBe(4);

    // And a call carrying the flag leaves it, which is the only thing that makes it skippable.
    const carried = await copyFrom(client, 99_999_999, true);
    expect(tallyOf(carried, "CountedFiles")).toEqual({ stored: 0, alreadyStored: 0 });
  });

  // What one call cannot account for, and why the script adds a run up rather than reading the
  // last report. A call opened past the end of D1's prose walks none of it, and no row count the
  // object can be asked will say so: it holds the chunks it indexed itself, so `tenant >= account`
  // is satisfied by an account nothing was ever copied into. What the call reports instead is how
  // much it walked against how much D1 holds.
  it("walks no prose when opened past the end of it, and reports what it walked", async () => {
    const h = await harness();
    const client = await owner(h);
    const sessionId = crypto.randomUUID();
    await seedSession(client.userId, sessionId, "rebuild the archive reader", true);

    const report = await copyFrom(client, 99_999_999);
    expect(report.chunks.stored + report.chunks.alreadyStored).toBe(0);
    expect(report.chunks.inAccount).toBe(PROSE.length);
    expect(report.checks.missingChunks).toBe(0);
    expect(await tenantChunks(client.userId)).toEqual([]);
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
    // The object's session row says something else now — another focus, another activity — and is
    // still answered for as the row D1 holds, because what identifies a session is its id and the
    // account's, not the state it has moved on to.
    expect(tallyOf(report, "Sessions")).toEqual({ stored: 0, alreadyStored: 1 });
    expect(blockedOf(report)).toEqual([]);
    expect(collidedOf(report)).toEqual([]);
    expect(report.chunks.stored).toBe(PROSE.length);
    expect(report.chunks.moved).toBe(1);
    expect(report.chunks.shifted).toBeGreaterThan(0);
    // SQLite's own read of the index the move hand-wrote: no entry left at the rowid the mover
    // vacated, and the one it moved to is there.
    expect(report.checks.chunkIndex).toEqual({ state: "Sound" });
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

  // The third thing a chunk is recognised by. A session and a text are not enough to say two rows
  // are one chunk: a session says the same thing twice over a long enough day, and the object
  // writing that again under a `chunk_seq` D1 handed this account would have the copy read its own
  // earlier work where there was none and drop a chunk of history. The instant the chunk opened on
  // is what separates them.
  //
  // A row matching all three is the same chunk whoever wrote it — a session replayed after the
  // cutover re-chunks the same bytes at the same instants, and the copy leaving those where they
  // stand loses nothing. This stands the other case: same session, same prose, another instant.
  it("copies a chunk whose prose the object already holds at another instant", async () => {
    const h = await harness();
    const client = await owner(h);
    const sessionId = crypto.randomUUID();
    await seedSession(client.userId, sessionId, "rebuild the archive reader", true);
    const before = await accountChunks(client.userId);
    const first = before[0];
    if (first === undefined) throw new Error("the seed wrote no chunk");

    expect((await client.sync(sessionId)).status).toBe(204);
    await tenantRows(
      client.userId,
      "INSERT INTO session_chunks (chunk_seq, user_id, session_id, ordinal, speaker, text, embedding, at) VALUES (?1, ?2, ?3, 0, 'model', ?4, ?5, ?6)",
      first.chunk_seq,
      client.userId,
      sessionId,
      first.text,
      (await embeddingFor(first.text)).slice().buffer,
      AT + 9_000,
    );

    const report = await copy(client);
    expect(tallyOf(report, "Chunks")).toEqual({ stored: PROSE.length, alreadyStored: 0 });
    expect(report.chunks.moved).toBe(1);
    expect(report.checks.ok).toBe(true);
    expect(await tenantChunks(client.userId)).toHaveLength(PROSE.length + 1);
  });

  // The two schemas are two declarations of one table, and the id is only worth anything while
  // they stay that way. A column one of them names differently, or carries and the other does
  // not, writes the row out differently and every id stops matching — which reads as a copy that
  // brought nothing over rather than as the drift it is.
  it("writes one row out the same way from either schema", () => {
    const row = {
      userId: "user-1",
      sessionId: "s-1",
      deviceId: "device-1",
      deviceName: "laptop",
      host: "laptop",
      cwd: "/home/you/src/recall",
      repo: "repo:recall",
      branch: "main",
      commitSubject: "feat: ship it",
      startedAt: AT,
      lastActivityAt: AT,
      prompts: 3,
      focusFirst: "rebuild the archive reader",
      focusLatest: "rebuild the archive reader",
      mode: "interactive",
      permissionMode: "default",
      pid: 4242,
      agentName: "",
    };
    expect(rowName(legacySessions, row, null)).toBe(rowName(sessions, row, null));
    const key = new Set(["user_id", "session_id"]);
    expect(rowName(legacySessions, row, key)).toBe(rowName(sessions, row, key));
    // And the identity reading is a reading of the identity: a row that moved on since the cutover
    // is the same row under it, and a different row is not.
    expect(rowName(sessions, { ...row, focusFirst: "what the host says now" }, key)).toBe(rowName(sessions, row, key));
    expect(rowName(sessions, { ...row, sessionId: "s-2" }, key)).not.toBe(rowName(sessions, row, key));
  });

  // The failure every round of this went looking for. A row of D1 that cannot land because another
  // row stands where it belongs used to be indistinguishable from a row already copied: both were
  // an insert that quietly did nothing. The object is asked for the row by its id first, so the
  // three answers are three answers, and this one fails the run and names the row.
  it("names the row that did not cross and does not verify", async () => {
    const h = await harness();
    const client = await owner(h);
    const sessionId = crypto.randomUUID();
    await seedSession(client.userId, sessionId, "rebuild the archive reader", true);
    await env.DB.prepare(INSERT_USAGE).bind(client.userId, sessionId, AT).run();
    // Another usage event under the key D1's own holds, which a usage event is not: one is written
    // once and never moved on, so the whole row is what the id is taken over.
    await tenantRows(
      client.userId,
      `INSERT INTO usage_events (user_id, session_id, seq, provider, account, model, prompts, input_tokens,
         output_tokens, cache_write_tokens, cache_read_tokens, at, recorded_at)
       VALUES (?1, ?2, 1, 'anthropic', 'max', 'opus', 9, 1, 1, 1, 1, ?3, ?3)`,
      client.userId,
      sessionId,
      AT,
    );

    const report = await copy(client);
    const usage = report.tables.find((row) => row.table === "UsageEvents");
    expect(usage?.stored).toBe(0);
    expect(usage?.alreadyStored).toBe(0);
    expect(usage?.blocked).toBe(1);
    expect(usage?.blockedIds).toHaveLength(1);
    // Read by the whole row, so a blocked one means another row of other content is in its place
    // — the thing to go and read, rather than a key taken while the run was going.
    expect(usage?.identity).toBe("WholeRow");
    expect(report.checks.ok).toBe(false);
    // Nothing else is dragged down with it: the tables that did cross still read as crossed.
    expect(tallyOf(report, "Sessions")).toEqual({ stored: 1, alreadyStored: 0 });
    expect(collidedOf(report)).toEqual([]);
    // And D1 still holds the row the operator is being pointed at.
    const left = await env.DB.prepare("SELECT prompts FROM usage_events WHERE user_id = ?1 AND session_id = ?2")
      .bind(client.userId, sessionId)
      .first<{ prompts: number }>();
    expect(left?.prompts).toBe(3);
  });
});
