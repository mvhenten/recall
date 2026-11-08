import { describe, expect, it } from "vitest";
import type { Embedder } from "../src/model";
import { harness, tenantRows, wordEmbedder } from "./harness";

const stamp = (turn: number): string => new Date(1_700_000_000_000 + turn * 1_000).toISOString();

// One exchange about one subject, long enough to close a chunk of its own, so what a test reads
// back off the index is a function of the prose and not of how the stretches were cut.
const about = (turn: number, subject: string): string[] => [
  JSON.stringify({
    type: "user",
    timestamp: stamp(turn),
    origin: { kind: "human" },
    message: { content: `${subject}: ${`what ${subject} does, and why it does it that way. `.repeat(20)}` },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: stamp(turn),
    message: {
      model: "claude-opus-5",
      content: [{ type: "text", text: `${subject} works like this: ${`${subject} does its job. `.repeat(20)}` }],
    },
  }),
];

const fileOf = (records: readonly string[]): string => `${records.join("\n")}\n`;

const run = (from: number, turns: number, subject: string): string => {
  const written: string[] = [];
  for (let turn = from; turn < from + turns; turn += 1) written.push(...about(turn, subject));
  return fileOf(written);
};

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

// Every text the indexer handed the model, which is what says how much of a transcript a pass
// read. A pass over prose it should never have opened shows up here whatever it then wrote.
const recorder = (): { embedder: Embedder; read: () => string } => {
  const texts: string[] = [];
  return {
    read: () => texts.join("\n"),
    embedder: {
      embed(given: string[]): Promise<Float32Array[]> {
        texts.push(...given);
        return wordEmbedder.embed(given);
      },
    },
  };
};

const BACKLOG = ["the offset table", "the labels tab", "the signing key"] as const;

// The store a session moves to holds nothing of it, and the archive holds the whole of it. That
// state is what this clears: the row the appends left behind goes, and R2 stays where it is.
const unseen = (userId: string, sessionId: string): Promise<unknown[]> =>
  tenantRows(userId, "DELETE FROM session_index WHERE user_id = ? AND session_id = ?", userId, sessionId);

describe("a session the tenant store has never indexed", () => {
  // The whole of a running session's transcript is in the archive and none of it is in the store
  // the session moved to. A mark opening at zero would call that a gap and have the consumer read
  // and embed every byte of it, one queue message at a time, for every live session at once.
  it("opens its mark level with the archive, so the first stretch is the only prose it reads", async () => {
    const seen = recorder();
    const h = await harness({ embedder: seen.embedder });
    const client = await h.user("moved");
    const sessionId = "s-moved";
    await client.sync(sessionId);
    let reach = 0;
    for (const [at, subject] of BACKLOG.entries()) {
      const part = run(at * 180, 180, subject);
      expect((await client.archive(sessionId, "main", reach, part)).status).toBe(200);
      reach += bytes(part);
    }
    expect(reach).toBeGreaterThan(1_048_576);
    await unseen(client.userId, sessionId);

    const grew = run(BACKLOG.length * 180, 4, "the retention sweep");
    expect((await client.archive(sessionId, "main", reach, grew)).status).toBe(200);
    await h.deliver();

    expect(await h.indexMark(client.userId, sessionId)).toMatchObject({
      archived: reach + bytes(grew),
      bytes: reach + bytes(grew),
    });
    // A whole-file re-read runs past one bite, which would leave the session behind and its
    // messages going back for redelivery until the archive had been embedded whole.
    expect(h.retried()).toBe(0);
    expect(seen.read()).toContain("the retention sweep");
    for (const subject of BACKLOG) expect(seen.read()).not.toContain(subject);
    const indexed = (await h.chunks(client.userId, sessionId)).join("\n");
    expect(indexed).toContain("the retention sweep");
    for (const subject of BACKLOG) expect(indexed).not.toContain(subject);
  });

  // The seed is the insert and nothing else, because the row of a session this store already holds
  // says how far its own passes read and no append knows that. A session a backfill left behind
  // its archive is where the two part company: an append rewriting the row would carry the mark
  // past the bytes nothing has read, and that prose would never be indexed at all.
  it("leaves a session it has already indexed where its own passes put it", async () => {
    const h = await harness();
    const client = await h.user("running");
    const sessionId = "s-running";
    await client.sync(sessionId);
    let reach = 0;
    for (const [at, subject] of BACKLOG.entries()) {
      const part = run(at * 180, 180, subject);
      expect((await client.archive(sessionId, "main", reach, part)).status).toBe(200);
      reach += bytes(part);
    }
    await h.deliver();
    const behind = await h.indexMark(client.userId, sessionId);
    expect(behind).toMatchObject({ archived: reach });
    expect(behind?.bytes).toBeLessThan(reach);
    expect(behind?.bytes).toBeGreaterThan(0);

    const grew = run(BACKLOG.length * 180, 4, "the retention sweep");
    expect((await client.archive(sessionId, "main", reach, grew)).status).toBe(200);

    expect(await h.indexMark(client.userId, sessionId)).toMatchObject({
      archived: reach + bytes(grew),
      bytes: behind?.bytes ?? -1,
    });
    await h.deliver();
    await h.deliver();
    const grown = (await h.chunks(client.userId, sessionId)).join("\n");
    for (const subject of [...BACKLOG, "the retention sweep"]) expect(grown).toContain(subject);
    expect(await h.indexMark(client.userId, sessionId)).toMatchObject({ bytes: reach + bytes(grew) });
  });

  // The way back to a searchable archive, and the whole of what the seed trades away. `recall
  // sessions --replay` sends the file as records, which takes the session off the byte path and
  // indexes the prose the seed left unread.
  it("indexes the whole archive once a replay takes a seeded session over", async () => {
    const h = await harness();
    const client = await h.user("replayed");
    const sessionId = "s-replayed";
    await client.v2.sync(sessionId);
    const records = BACKLOG.flatMap((subject, turn) => about(turn, subject));
    const file = fileOf(records);
    expect((await client.archive(sessionId, "main", 0, file)).status).toBe(200);
    await unseen(client.userId, sessionId);
    const grew = about(BACKLOG.length, "the retention sweep");
    expect((await client.archive(sessionId, "main", bytes(file), fileOf(grew))).status).toBe(200);
    await h.deliver();
    for (const subject of BACKLOG) expect((await h.chunks(client.userId, sessionId)).join("\n")).not.toContain(subject);

    expect((await client.v2.records(sessionId, "main", 0, [...records, ...grew])).status).toBe(200);
    expect((await client.v2.end(sessionId)).status).toBe(204);

    const replayed = (await h.chunks(client.userId, sessionId)).join("\n");
    for (const subject of [...BACKLOG, "the retention sweep"]) expect(replayed).toContain(subject);
  });
});
