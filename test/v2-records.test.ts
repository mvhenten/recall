import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_RECORDS_BYTES, MAX_RECORDS_PER_APPEND, RECORDS_PREFIX } from "../src/records";
import { harness } from "./harness";

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

    // The same prose reaches the archive both ways: a byte-path stretch, which a storage event
    // would otherwise index, and a record append, which indexes itself inside the request.
    expect((await client.archive(session, "main", 0, `${records.join("\n")}\n`)).status).toBe(200);
    expect((await client.v2.records(session, "main", 0, records)).status).toBe(200);
    const indexed = await chunkCount(client.userId, session);
    expect(indexed).toBeGreaterThan(0);

    await deliver();
    expect(await chunkCount(client.userId, session)).toBe(indexed);
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
