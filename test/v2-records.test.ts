import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Embedder } from "../src/model";
import { MAX_RECORDS_BYTES, MAX_RECORDS_PER_APPEND, RECORDS_PREFIX } from "../src/records";
import { harness, wordEmbedder } from "./harness";

const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);

const prompt = (at: number, text: string): string =>
  line({
    type: "user",
    timestamp: new Date(1_700_000_000_000 + at * 1_000).toISOString(),
    origin: { kind: "human" },
    message: { content: text },
  });

const answer = (at: number, text: string): string =>
  line({
    type: "assistant",
    timestamp: new Date(1_700_000_000_000 + at * 1_000).toISOString(),
    message: { model: "claude-opus-5", content: [{ type: "text", text }] },
  });

// One exchange about one subject, long enough to fill a chunk on its own, so where the chunker
// closes is a function of the prose and never of how many records came in one call.
const about = (at: number, subject: string): string[] => [
  prompt(at, `${subject}: ${`what ${subject} does and why it does it that way. `.repeat(12)}`),
  answer(at, `${subject} works like this: ${`${subject} does its job that way. `.repeat(12)}`),
];

const SUBJECTS = ["routing", "storage", "embedding", "sharing", "auditing", "pagination"] as const;

const conversation = (): string[] => SUBJECTS.flatMap((subject, at) => about(at, subject));

interface ChunkRow {
  speaker: string;
  text: string;
  at: number;
}

const chunksOf = async (userId: string, sessionId: string): Promise<ChunkRow[]> => {
  const { results } = await env.DB.prepare(
    "SELECT speaker, text, at FROM session_chunks WHERE user_id = ? AND session_id = ? ORDER BY ordinal",
  )
    .bind(userId, sessionId)
    .all<ChunkRow>();
  return results;
};

// What a chunk is, said apart from where in the index it landed. Two batchings reach the same
// ordinals only if they also closed in the same order; what carrying the open chunk promises is
// that the set of chunks is the same.
const setOf = (chunks: ChunkRow[]): string[] =>
  chunks.map((chunk) => `${chunk.at}/${chunk.speaker}/${chunk.text}`).sort();

const chunkCount = async (userId: string, sessionId: string): Promise<number> =>
  (await chunksOf(userId, sessionId)).length;

// One point two concurrent requests can be steered by, so a test can say which of them reaches the
// archive first and which one finds the mark moved.
const signal = (): { waited: Promise<void>; fire: () => void } => {
  let fire = (): void => {};
  const waited = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { waited, fire };
};

describe("POST /v2/sessions/{sessionId}/records", () => {
  it("takes the next ordinal and refuses one on either side of it", async () => {
    const { user } = await harness();
    const client = await user("ordering");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const records = conversation();

    const ahead = await client.v2.records(session, "main", 3, records.slice(0, 2));
    expect(ahead.status).toBe(409);
    expect(await ahead.json()).toMatchObject({ next: 0 });

    const first = await client.v2.records(session, "main", 0, records.slice(0, 4));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ file: "main", next: 4 });

    const behind = await client.v2.records(session, "main", 1, records.slice(1, 3));
    expect(behind.status).toBe(409);
    expect(await behind.json()).toMatchObject({ next: 4 });

    const carried = await client.v2.records(session, "main", 4, records.slice(4, 6));
    expect(carried.status).toBe(200);
    expect(await carried.json()).toEqual({ file: "main", next: 6 });
  });

  it("answers a replayed append the real next and indexes nothing a second time", async () => {
    const { user } = await harness();
    const client = await user("replay");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const records = conversation();

    expect((await client.v2.records(session, "main", 0, records)).status).toBe(200);
    const indexed = await chunkCount(client.userId, session);

    const replayed = await client.v2.records(session, "main", 0, records);
    expect(replayed.status).toBe(409);
    expect(await replayed.json()).toMatchObject({ next: records.length });
    expect(await chunkCount(client.userId, session)).toBe(indexed);
  });

  it("lets one of two appends at the same ordinal land and tells the other the real next", async () => {
    const { user } = await harness();
    const client = await user("race");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const records = conversation();

    const [left, right] = await Promise.all([
      client.v2.records(session, "main", 0, records.slice(0, 4)),
      client.v2.records(session, "main", 0, records.slice(0, 6)),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);

    const won = left.status === 200 ? left : right;
    const lost = left.status === 200 ? right : left;
    const taken: { next: number } = await won.json();
    const refused: { next: number } = await lost.json();
    expect(refused.next).toBe(taken.next);

    // One object holds a whole append, so the archive carries the winner's records once and the
    // loser's body nowhere at all.
    const held = await env.TRANSCRIPTS.list({ prefix: `${RECORDS_PREFIX}/${client.userId}/${session}/main/` });
    expect(held.objects).toHaveLength(1);
  });

  it("refuses an append past either ceiling, naming the one it exceeded", async () => {
    const { user } = await harness();
    const client = await user("ceilings");
    const session = crypto.randomUUID();
    await client.v2.sync(session);

    const tooMany = Array.from({ length: MAX_RECORDS_PER_APPEND + 1 }, (_, at) => prompt(at, `turn ${at}`));
    const counted = await client.v2.records(session, "main", 0, tooMany);
    expect(counted.status).toBe(413);
    expect(await counted.text()).toContain(`at most ${MAX_RECORDS_PER_APPEND} records`);

    const weighed = await client.v2.records(session, "main", 0, [prompt(0, "x".repeat(MAX_RECORDS_BYTES))]);
    expect(weighed.status).toBe(413);
    expect(await weighed.text()).toContain(`at most ${MAX_RECORDS_BYTES} bytes`);
  });

  it("closes the same chunks whether the records arrive in one append or in three", async () => {
    const { user } = await harness();
    const client = await user("batched");
    const records = conversation();

    const whole = crypto.randomUUID();
    await client.v2.sync(whole);
    expect((await client.v2.records(whole, "main", 0, records)).status).toBe(200);

    const split = crypto.randomUUID();
    await client.v2.sync(split);
    const batch = Math.ceil(records.length / 3);
    for (let at = 0; at < records.length; at += batch) {
      expect((await client.v2.records(split, "main", at, records.slice(at, at + batch))).status).toBe(200);
    }

    const once = await chunksOf(client.userId, whole);
    const thrice = await chunksOf(client.userId, split);
    expect(once.length).toBeGreaterThan(1);
    expect(setOf(thrice)).toEqual(setOf(once));
  });

  it("keeps the byte path's consumer off a session on the record mark", async () => {
    const { user, deliver } = await harness();
    const client = await user("marked");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const records = conversation();

    // The same prose reaches the archive both ways: a record append, which indexes itself inside
    // the request, and a byte-path stretch, which a storage event would otherwise index.
    expect((await client.v2.records(session, "main", 0, records)).status).toBe(200);
    expect((await client.archive(session, "main", 0, `${records.join("\n")}\n`)).status).toBe(200);
    const indexed = await chunkCount(client.userId, session);
    expect(indexed).toBeGreaterThan(0);

    await deliver();
    expect(await chunkCount(client.userId, session)).toBe(indexed);
  });

  // The reverse order, which the mark alone cannot answer: the queue drains first and indexes the
  // prose at ordinals the record append would then index it at a second time. One session takes
  // one path into the index, and the one it took is the one that wrote it.
  it("refuses records for a session the byte path already wrote", async () => {
    const { user, deliver } = await harness();
    const client = await user("crossed");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const records = conversation();

    expect((await client.archive(session, "main", 0, `${records.join("\n")}\n`)).status).toBe(200);
    await deliver();
    const indexed = await chunkCount(client.userId, session);
    expect(indexed).toBeGreaterThan(0);

    const refused = await client.v2.records(session, "main", 0, records);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("two paths");
    expect(await chunkCount(client.userId, session)).toBe(indexed);
  });

  // A delegated file is the model talking to itself and derives nothing, so an append of one must
  // leave the byte path free to index the session's own prose.
  it("leaves the byte path indexing a session whose delegated turn took records", async () => {
    const { user, deliver } = await harness();
    const client = await user("delegated");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const records = conversation();

    expect((await client.v2.records(session, "main-agent-1", 0, records)).status).toBe(200);
    expect(await chunkCount(client.userId, session)).toBe(0);

    expect((await client.archive(session, "main", 0, `${records.join("\n")}\n`)).status).toBe(200);
    await deliver();
    expect(await chunkCount(client.userId, session)).toBeGreaterThan(0);
  });

  // Ordinals are implicit in position, so a host knows its next `from` without asking and sends
  // the second append while the first is still embedding. The second reads the chunks and the open
  // chunk of a file the first has not finished writing, so one of the two must lose and be told.
  it("refuses the later of two pipelined appends rather than losing its chunks", async () => {
    let reached = (): void => {};
    const atEmbedder = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const gated: Embedder = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        if (first) {
          first = false;
          reached();
          await held;
        }
        return wordEmbedder.embed(texts);
      },
    };

    const { user } = await harness({ embedder: gated });
    const client = await user("pipelined");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const records = conversation();

    // The leading append closes a chunk and so reaches the embedder, which is where it is held
    // while the following one runs the whole of the request path beside it.
    const leading = client.v2.records(session, "main", 0, records.slice(0, 8));
    await atEmbedder;
    const following = await client.v2.records(session, "main", 8, records.slice(8));
    release();
    const led = await leading;

    expect([led.status, following.status].sort()).toEqual([200, 409]);
    const lost = led.status === 409 ? led : following;
    const { next }: { next: number } = await lost.json();
    expect(next).toBe(records.length);

    // The mark, the chunk counter and the chunk ordinals all say the same thing: one append's
    // chunks are in the index whole, and the other wrote none of its own over them.
    const marked = await env.DB.prepare(
      "SELECT next_ordinal FROM session_records WHERE user_id = ? AND session_id = ? AND file = 'main'",
    )
      .bind(client.userId, session)
      .first<{ next_ordinal: number }>();
    expect(next).toBe(marked?.next_ordinal);

    const counted = await env.DB.prepare("SELECT chunks FROM session_index WHERE user_id = ? AND session_id = ?")
      .bind(client.userId, session)
      .first<{ chunks: number }>();
    const indexed = await chunksOf(client.userId, session);
    expect(indexed.length).toBeGreaterThan(0);
    expect(counted?.chunks).toBe(indexed.length);

    // The refused host sends again at the ordinal it was handed and lands, which is the sequence
    // terminating rather than the two of them taking turns losing the file.
    const resumed = await client.v2.records(session, "main", next, about(6, "retention"));
    expect(resumed.status).toBe(200);

    // Nothing was dropped. The loser's records are in the archive under their own key and only the
    // winner read them for turns, so every subject of the conversation is in the index once the
    // session closes the chunk it was still filling.
    expect((await client.v2.end(session)).status).toBe(204);
    const said = (await chunksOf(client.userId, session)).map((chunk) => chunk.text).join("\n");
    for (const subject of [...SUBJECTS, "retention"]) expect(said).toContain(`${subject}:`);
  });

  // The same loss on the last append a session ever makes. Another append would carry the index
  // over the span the loser stored, but the session that ends there never sends one, so the end of
  // it is the only thing left that can index those records.
  it("indexes the records the last append of a session left ahead of the mark", async () => {
    const leadingAt = signal();
    const leadingGo = signal();
    const followerAt = signal();
    const followerGo = signal();
    let calls = 0;
    const gated: Embedder = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        calls += 1;
        const at = calls;
        if (at === 1) {
          leadingAt.fire();
          await leadingGo.waited;
        }
        if (at === 2) {
          followerAt.fire();
          await followerGo.waited;
        }
        return wordEmbedder.embed(texts);
      },
    };

    const { user } = await harness({ embedder: gated });
    const client = await user("tail");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const records = conversation();

    // Both appends store their records and then stop at the embedder. The leading one is let go
    // first and takes the mark, which leaves the follower committing against a mark that moved.
    const leading = client.v2.records(session, "main", 0, records.slice(0, 8));
    await leadingAt.waited;
    const following = client.v2.records(session, "main", 8, records.slice(8));
    await followerAt.waited;
    leadingGo.fire();
    expect((await leading).status).toBe(200);
    followerGo.fire();
    const lost = await following;
    expect(lost.status).toBe(409);
    expect(await lost.json()).toMatchObject({ next: 8 });

    // The follower's records are in the archive at ordinal 8 and nothing read them for turns.
    const stranded = ["auditing", "pagination"];
    const before = (await chunksOf(client.userId, session)).map((chunk) => chunk.text).join("\n");
    for (const subject of stranded) expect(before).not.toContain(`${subject}:`);

    expect((await client.v2.end(session)).status).toBe(204);
    const said = (await chunksOf(client.userId, session)).map((chunk) => chunk.text).join("\n");
    for (const subject of SUBJECTS) expect(said).toContain(`${subject}:`);

    const marked = await env.DB.prepare(
      "SELECT next_ordinal FROM session_records WHERE user_id = ? AND session_id = ? AND file = 'main'",
    )
      .bind(client.userId, session)
      .first<{ next_ordinal: number }>();
    expect(marked?.next_ordinal).toBe(records.length);
  });

  // The archive takes a record once. A host sending different prose at an ordinal it already wrote
  // is rewriting a transcript, and neither its records nor the stored ones may be dropped for the
  // other without it being told.
  it("refuses an append whose records differ from the ones stored at its ordinal", async () => {
    const { user } = await harness();
    const client = await user("rewritten");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const records = conversation();

    expect((await client.v2.records(session, "main", 0, records.slice(0, 4))).status).toBe(200);
    const stored = await client.v2.transcript(session, "main");
    expect((await stored.text()).split("\n")).toEqual(records.slice(0, 4));

    // The mark is at 4 and the archive holds an object at 4, which only a writer that stored
    // records and lost the file leaves behind; the host sends other prose at the same ordinal.
    const [kept, other] = records.slice(4, 6);
    await env.TRANSCRIPTS.put(`${RECORDS_PREFIX}/${client.userId}/${session}/main/${"0".repeat(15)}4`, kept ?? "", {
      customMetadata: { records: "1" },
    });
    const rewritten = await client.v2.records(session, "main", 4, [other ?? ""]);
    expect(rewritten.status).toBe(409);
    expect(await rewritten.text()).toContain("written once");
  });

  it("makes what it indexed findable by meaning", async () => {
    const { user } = await harness();
    const client = await user("searchable");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    expect((await client.v2.records(session, "main", 0, conversation())).status).toBe(200);

    const found = await client.v2.searchHistory("pagination");
    expect(found.status).toBe(200);
    const { hits }: { hits: Array<{ session: { sessionId: string } }> } = await found.json();
    expect(hits.map((hit) => hit.session.sessionId)).toContain(session);
  });

  // A chunk closes where the conversation turns or where the ceiling runs out, so the last one of
  // a session closes nowhere at all. A short session turns nowhere and would be unfindable whole.
  it("makes the last turn of a session findable once the session ends", async () => {
    const { user } = await harness();
    const client = await user("ending");
    const session = crypto.randomUUID();
    await client.v2.sync(session);

    const said = `the quarterly reconciliation runs against the ledger snapshot ${crypto.randomUUID().slice(0, 8)}`;
    expect((await client.v2.records(session, "main", 0, [prompt(0, said)])).status).toBe(200);
    expect(await chunkCount(client.userId, session)).toBe(0);

    expect((await client.v2.end(session)).status).toBe(204);
    const closed = await chunksOf(client.userId, session);
    expect(closed.map((chunk) => chunk.text)).toContain(said);

    const found = await client.v2.searchHistory("reconciliation ledger snapshot");
    const { hits }: { hits: Array<{ session: { sessionId: string } }> } = await found.json();
    expect(hits.map((hit) => hit.session.sessionId)).toContain(session);
  });

  it("lists and reads back the transcript of a session that only ever posted records", async () => {
    const { user } = await harness();
    const client = await user("readback");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const records = conversation();

    expect((await client.v2.records(session, "main", 0, records.slice(0, 4))).status).toBe(200);
    expect((await client.v2.records(session, "main", 4, records.slice(4))).status).toBe(200);
    expect((await client.v2.records(session, "main-agent-1", 0, [prompt(0, "delegated")])).status).toBe(200);

    const listed = await client.v2.files(session);
    expect(listed.status).toBe(200);
    const { files }: { files: Array<{ file: string; bytes: number }> } = await listed.json();
    expect(files.map((file) => file.file)).toEqual(["main", "main-agent-1"]);

    const read = await client.v2.transcript(session, "main");
    expect(read.status).toBe(200);
    expect((await read.text()).split("\n")).toEqual(records);

    const described = await client.v2.session(session);
    const { files: held }: { files: Array<{ file: string }> } = await described.json();
    expect(held.map((file) => file.file)).toContain("main");
  });

  it("refuses to read or append to another account's session", async () => {
    const { user } = await harness();
    const owner = await user("owner");
    const stranger = await user("stranger");
    const session = crypto.randomUUID();
    await owner.v2.sync(session);
    expect((await owner.v2.records(session, "main", 0, conversation())).status).toBe(200);

    expect((await stranger.v2.session(session)).status).toBe(404);
    expect((await stranger.v2.files(session)).status).toBe(404);
    expect((await stranger.v2.records(session, "main", 0, conversation())).status).toBe(404);

    // The owner's archive is untouched by the refusals, and the stranger's own prefix holds
    // nothing at all.
    const owned = await env.TRANSCRIPTS.list({ prefix: `${RECORDS_PREFIX}/${owner.userId}/${session}/` });
    const strange = await env.TRANSCRIPTS.list({ prefix: `${RECORDS_PREFIX}/${stranger.userId}/` });
    expect(owned.objects).toHaveLength(1);
    expect(strange.objects).toHaveLength(0);
  });
});
