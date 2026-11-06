import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY_MS, USAGE_RETENTION_MS } from "../src/model";
import { followedBatch } from "../src/transcript-plan";
import {
  archivedSince,
  archivedTranscript,
  legacyStretchName,
  MAX_CHUNK_BYTES,
  readStretch,
  stretchName,
} from "../src/transcripts";
import { harness } from "./harness";

// How far into each of a session's files the archive reaches, which is what a host sends on from.
const held = async (response: Response): Promise<Record<string, number>> => {
  expect(response.status).toBe(200);
  const { files } = (await response.json()) as { files: Array<{ file: string; through: number }> };
  return Object.fromEntries(files.map(({ file, through }) => [file, through]));
};

// How many bytes of each file the archive holds, which a redacted file runs to another length
// than.
const holds = async (response: Response): Promise<Record<string, number>> => {
  expect(response.status).toBe(200);
  const { files } = (await response.json()) as { files: Array<{ file: string; bytes: number }> };
  return Object.fromEntries(files.map(({ file, bytes }) => [file, bytes]));
};

const counted = async (response: Response): Promise<string[]> => {
  expect(response.status).toBe(200);
  const { counted: files } = (await response.json()) as { counted: string[] };
  return files;
};

const rollup = async (userId: string): Promise<Array<Record<string, unknown>>> => {
  const { results } = await env.DB.prepare(
    "SELECT day, model, prompts, input_tokens FROM usage_daily WHERE user_id = ? ORDER BY day, model",
  )
    .bind(userId)
    .all();
  return results;
};

describe("transcript archive", () => {
  it("takes a session's files a stretch at a time and says where each one reaches", async () => {
    const h = await harness();
    const client = await h.user("archivist");
    await client.sync("s-1");

    expect(await held(await client.transcript("s-1"))).toEqual({});
    const first = await client.archive("s-1", "main", 0, "one\ntwo\n");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ file: "main", through: 8 });
    await client.archive("s-1", "main", 8, "three\n");
    await client.archive("s-1", "agent-7f21", 0, "delegated\n");

    expect(await held(await client.transcript("s-1"))).toEqual({ main: 14, "agent-7f21": 10 });
  });

  // The whole of what a retry costs: a stretch is stored under the offset it was sent at and only
  // where nothing is yet, so sending it again is refused with where the file reaches rather than
  // leaving a second copy of the same lines beside it.
  it("refuses a stretch sent twice, and says where the file reaches", async () => {
    const h = await harness();
    const client = await h.user("retrier");
    await client.sync("s-2");
    await client.archive("s-2", "main", 0, "one\ntwo\n");

    const again = await client.archive("s-2", "main", 0, "one\ntwo\n");

    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ through: 8 });
    expect(await held(await client.transcript("s-2"))).toEqual({ main: 8 });
    expect(await (await client.readTranscript("s-2", "main")).text()).toBe("one\ntwo\n");
    const resumed = await client.archive("s-2", "main", 8, "three\n");
    expect(resumed.status).toBe(200);
    expect(await held(await client.transcript("s-2"))).toEqual({ main: 14 });
  });

  it("refuses a stretch past the body cap", async () => {
    const h = await harness();
    const client = await h.user("flooder");
    await client.sync("s-3");

    const response = await client.archive("s-3", "main", 0, "x".repeat(MAX_CHUNK_BYTES + 1));

    expect(response.status).toBe(413);
    expect(await held(await client.transcript("s-3"))).toEqual({});
  });

  it("answers no caller the session does not belong to", async () => {
    const h = await harness();
    const owner = await h.user("owner");
    const stranger = await h.user("stranger");
    await owner.sync("s-4");
    await owner.archive("s-4", "main", 0, "one\n");

    expect((await stranger.transcript("s-4")).status).toBe(404);
    expect((await stranger.archive("s-4", "main", 0, "mine now\n")).status).toBe(404);
    expect((await owner.transcript("s-unknown")).status).toBe(404);
    const anonymous = await h.send("/v1/sessions/s-4/transcript");
    expect(anonymous.status).toBe(401);

    expect(await held(await owner.transcript("s-4"))).toEqual({ main: 4 });
  });

  // The half the archive exists for. A host that backfilled before the counter read delegated
  // turns has its own transcripts counted and those files counted nowhere, and that is most of
  // what its sessions spent. The run that recovers them asks which files are counted, which is a
  // usage fact and not an archive one.
  it("recovers the delegated turns of a session on record, and counts them once", async () => {
    const h = await harness();
    const userId = `recoverer-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    // A host that backfilled before the counter read delegated turns: its own transcript counted,
    // the session on record.
    const own = { seq: 1, model: "claude-opus-4", inputTokens: 150, durable: true, files: ["main"] };
    expect((await client.usage("s-old", own)).status).toBe(204);
    expect((await client.sync("s-old")).status).toBe(204);
    const before = await rollup(userId);
    expect(await counted(await client.transcript("s-old"))).toEqual(["main"]);

    const turn = {
      seq: 2,
      model: "claude-opus-4",
      inputTokens: 700,
      prompts: 0,
      durable: true,
      files: ["agent-7f21"],
    };
    expect((await client.usage("s-old", turn)).status).toBe(204);

    expect(await counted(await client.transcript("s-old"))).toEqual(["agent-7f21", "main"]);
    const recovered = await rollup(userId);
    expect(recovered).not.toEqual(before);
    // Two weeks on, a run that sends it again regardless lands on the rows already there.
    h.tick(USAGE_RETENTION_MS + DAY_MS);
    expect((await client.usage("s-old", turn)).status).toBe(204);
    expect((await client.usage("s-old", turn)).status).toBe(204);
    expect(await rollup(userId)).toEqual(recovered);
  });

  // Two writers reaching one place in a file — the listener's beat and a session ending — hold
  // stretches that begin together and end apart, because they read the file at different instants.
  // A stretch is taken only where the archive reaches exactly the place it begins at, so one lands
  // and the other is told the reach, which is where its next stretch begins. No span of the file
  // is accounted for twice and none is left in no object at all.
  it("takes the stretch that begins where the archive reaches and sends the other writer on", async () => {
    const h = await harness();
    const userId = `racer-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-race");

    // A stretch that redacts to fewer bytes than the span of the file it accounts for, which is
    // why the span cannot be read back off the body.
    expect((await client.archiveSpan("s-race", "main", 0, 20, "fourteen bytes")).status).toBe(200);
    const beaten = await client.archiveSpan("s-race", "main", 0, 6, "four");

    expect(beaten.status).toBe(409);
    expect(await beaten.json()).toMatchObject({ through: 20 });
    const stored = await env.TRANSCRIPTS.list({ prefix: `${userId}/s-race/main/` });
    expect(stored.objects).toHaveLength(1);
    expect(stored.objects[0]?.key).toBe(`${userId}/s-race/main/${stretchName(0, 20)}`);
    expect(await (await client.readTranscript("s-race", "main")).text()).toBe("fourteen bytes");
    expect((await client.archiveSpan("s-race", "main", 20, 25, "five!")).status).toBe(200);
    expect(await (await client.readTranscript("s-race", "main")).text()).toBe("fourteen bytesfive!");
    expect(await held(await client.transcript("s-race"))).toEqual({ main: 25 });
    expect(await holds(await client.transcript("s-race"))).toEqual({ main: 19 });
  });

  // Two appends whose readings both landed before either wrote: two keys naming spans of the file
  // that overlap, which no listing could have refused. The longer is the one read, so the span
  // they share is in the archive once, and the writer that was passed over is told the reach on
  // its next append rather than writing on into a file nothing reads.
  it("reads the longer of two stretches that begin at one place, and sends the other writer back", async () => {
    const h = await harness();
    const userId = `doubled-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-both");
    const key = (from: number, through: number): string => `${userId}/s-both/main/${stretchName(from, through)}`;
    await env.TRANSCRIPTS.put(key(0, 6), "four");
    await env.TRANSCRIPTS.put(key(0, 20), "fourteen bytes");

    expect(await (await client.readTranscript("s-both", "main")).text()).toBe("fourteen bytes");
    expect(await held(await client.transcript("s-both"))).toEqual({ main: 20 });
    const beaten = await client.archiveSpan("s-both", "main", 6, 12, "six!!!");
    expect(beaten.status).toBe(409);
    expect(await beaten.json()).toMatchObject({ through: 20 });
  });

  // A stretch keyed before where the reader has read to, and ending past it, holds its unread
  // tail in no other object. The listing starts one stretch back from the reader's place, so the
  // straddler comes back and the reader reads forward across it from where it stands.
  it("names the stretch that begins before the reader has read to and ends past it", async () => {
    const userId = `straddler-${crypto.randomUUID()}`;
    const key = (offset: number): string => `${userId}/s-tail/main/${String(offset).padStart(16, "0")}`;
    await env.TRANSCRIPTS.put(key(0), "a".repeat(100));
    await env.TRANSCRIPTS.put(key(50), "b".repeat(150));

    const runs = await archivedSince(env.TRANSCRIPTS, userId, "s-tail", "main", 100);

    expect(followedBatch(runs, 100, 65_536)).toEqual({
      batch: [{ run: 0, at: legacyStretchName(50), offset: 50, skip: 50, bytes: 100 }],
      at: 200,
    });
  });

  // Two writers reach one file at once: one lands a later stretch, the box takes it, and the
  // other then lands the stretch below it, whose tail runs past where the box has read. A cursor
  // keyed by the last key taken would never name that stretch again and the bytes past it would
  // be missing until the page was reloaded.
  it("names a stretch written below a key the reader has already taken", async () => {
    const userId = `backfiller-${crypto.randomUUID()}`;
    const key = (offset: number): string => `${userId}/s-late/main/${String(offset).padStart(16, "0")}`;
    await env.TRANSCRIPTS.put(key(200), "y".repeat(50));
    const taken = await archivedSince(env.TRANSCRIPTS, userId, "s-late", "main", 150);
    expect(followedBatch(taken, 150, 65_536).at).toBe(250);

    await env.TRANSCRIPTS.put(key(150), "x".repeat(150));
    const late = await archivedSince(env.TRANSCRIPTS, userId, "s-late", "main", 250);

    expect(followedBatch(late, 250, 65_536)).toEqual({
      batch: [{ run: 0, at: legacyStretchName(150), offset: 150, skip: 100, bytes: 50 }],
      at: 300,
    });
  });

  // A beat is handed the reads that reach past the reader and no others, however far back the
  // file runs: the stretches it has already read cost it nothing to be told about again, and
  // naming them would grow every beat with the length of the session.
  it("names the reads past the reader and leaves the rest of a long file alone", async () => {
    const userId = `deep-${crypto.randomUUID()}`;
    const key = (offset: number): string => `${userId}/s-deep/main/${String(offset).padStart(16, "0")}`;
    const from = 4 * MAX_CHUNK_BYTES;
    await env.TRANSCRIPTS.put(key(0), "a");
    await env.TRANSCRIPTS.put(key(from - MAX_CHUNK_BYTES), "b");
    await env.TRANSCRIPTS.put(key(from), "c");

    const runs = await archivedSince(env.TRANSCRIPTS, userId, "s-deep", "main", from);

    expect(runs.map((run) => run.from)).toEqual([from]);
  });

  // Every key in the archive before redaction names one place, meaning a place in the file and in
  // the archive at once. Nothing rewrote them, so a host picks a file up from the place its last
  // key reaches and a reader walks it off the same keys.
  it("reads a file archived before a stretch could run to another length than the file", async () => {
    const h = await harness();
    const userId = `legacy-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-legacy");
    expect((await client.archiveLegacy("s-legacy", "main", 0, "one\ntwo\n")).status).toBe(200);
    const again = await client.archiveLegacy("s-legacy", "main", 8, "three\n");
    expect(await again.json()).toEqual({ file: "main", offset: 14 });

    expect(await held(await client.transcript("s-legacy"))).toEqual({ main: 14 });
    expect(await holds(await client.transcript("s-legacy"))).toEqual({ main: 14 });
    expect(await (await client.readTranscript("s-legacy", "main")).text()).toBe("one\ntwo\nthree\n");

    // The host updates: it takes the place the archive reaches into the file and sends a stretch
    // that redacts shorter than the span it accounts for, under a key naming both ends.
    expect((await client.archiveSpan("s-legacy", "main", 14, 30, "four\n")).status).toBe(200);
    expect(await held(await client.transcript("s-legacy"))).toEqual({ main: 30 });
    expect(await holds(await client.transcript("s-legacy"))).toEqual({ main: 19 });
    expect(await (await client.readTranscript("s-legacy", "main")).text()).toBe("one\ntwo\nthree\nfour\n");
  });

  // A reader fetching bytes off a manifest has to land on the right bytes of the right object,
  // and an object's place in the archive is the sizes of the objects in front of it rather than
  // anything its key says.
  it("hands back the right bytes of each stretch across spans and bodies of different lengths", async () => {
    const h = await harness();
    const userId = `ranged-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-ranged");
    // Three stretches, each accounting for a span of the file its own bytes do not run to.
    await client.archiveSpan("s-ranged", "main", 0, 40, "aaaa\n");
    await client.archiveSpan("s-ranged", "main", 40, 50, "bbbbbbbbbbbbbbb\n");
    await client.archiveSpan("s-ranged", "main", 50, 900, "cc\n");

    const files = await archivedTranscript(env.TRANSCRIPTS, userId, "s-ranged");
    const run = files[0]?.runs[0];
    expect(files[0]).toMatchObject({ file: "main", bytes: 24, through: 900 });
    expect(run?.reads.map((read) => [read.at, read.offset, read.skip, read.bytes])).toEqual([
      [stretchName(0, 40), 0, 0, 5],
      [stretchName(40, 50), 5, 0, 16],
      [stretchName(50, 900), 21, 0, 3],
    ]);
    expect(await (await client.readTranscript("s-ranged", "main")).text()).toBe("aaaa\nbbbbbbbbbbbbbbb\ncc\n");
    // The reader the index runs asks for a window of the archive, which the same accumulation
    // places: a window weighed against the keys would open in the wrong object entirely.
    const bite = await readStretch(env.TRANSCRIPTS, userId, "s-ranged", "main", 5, 24, 1_000);
    expect(bite).toEqual({ text: "bbbbbbbbbbbbbbb\ncc\n", through: 24 });
  });

  it("keeps a session's files once its row has moved to the history", async () => {
    const h = await harness();
    const client = await h.user("historian");
    await client.sync("s-5");
    await client.archive("s-5", "main", 0, "one\n");
    expect((await client.request("DELETE", "/v1/sessions/s-5")).status).toBe(204);

    const resumed = await client.archive("s-5", "main", 4, "two\n");

    expect(resumed.status).toBe(200);
    expect(await held(await client.transcript("s-5"))).toEqual({ main: 8 });
  });
});
