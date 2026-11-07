import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY_MS, USAGE_RETENTION_MS } from "../src/model";
import { compressedStretchName, followedBatch, legacyStretchName, stretchName } from "../src/transcript-plan";
import { archivedSince, archivedTranscript, MAX_STRETCH_BYTES, readStretch } from "../src/transcripts";
import { gzipped, harness } from "./harness";

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

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

const laidEndToEnd = (parts: Uint8Array[]): Uint8Array => {
  const all = new Uint8Array(parts.reduce((held, part) => held + part.byteLength, 0));
  let written = 0;
  for (const part of parts) {
    all.set(part, written);
    written += part.byteLength;
  }
  return all;
};

// A stretch shaped the way a transcript is: one JSON record a line, the same keys over and over and
// prose in between, which is what gzip has to work with on the real thing.
const turns = (count: number, tag: string): string =>
  `${Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      type: index % 2 === 0 ? "user" : "assistant",
      timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      message: { content: `${tag} ${index}: the archive holds every byte of this line as it stands.` },
    }),
  ).join("\n")}\n`;

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

    const response = await client.archive("s-3", "main", 0, "x".repeat(MAX_STRETCH_BYTES + 1));

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
  // tail in no other object. A one-segment cursor is read on the terms it was written under, so
  // the listing starts one stretch back from the reader's place, the straddler comes back and the
  // reader reads forward across it from where it stands.
  it("names the stretch that begins before the reader has read to and ends past it", async () => {
    const userId = `straddler-${crypto.randomUUID()}`;
    const key = (offset: number): string => `${userId}/s-tail/main/${legacyStretchName(offset)}`;
    await env.TRANSCRIPTS.put(key(0), "a".repeat(100));
    await env.TRANSCRIPTS.put(key(50), "b".repeat(150));

    const runs = await archivedSince(env.TRANSCRIPTS, userId, "s-tail", "main", 100, legacyStretchName(0));

    expect(followedBatch(runs, 100, 65_536)).toEqual({
      batch: [{ run: 0, at: legacyStretchName(50), offset: 50, skip: 50, bytes: 100 }],
      at: 200,
    });
  });

  // Two writers reach one file at once: one lands a later stretch, the box takes it, and the
  // other then lands the stretch below it, whose tail runs past where the box has read. A cursor
  // keyed by the last key taken would never name that stretch again and the bytes past it would
  // be missing until the page was reloaded. Only a writer of one-segment keys can land one there,
  // and that is the form this reaches back for.
  it("names a stretch written below a key the reader has already taken", async () => {
    const userId = `backfiller-${crypto.randomUUID()}`;
    const key = (offset: number): string => `${userId}/s-late/main/${legacyStretchName(offset)}`;
    await env.TRANSCRIPTS.put(key(200), "y".repeat(50));
    const taken = await archivedSince(env.TRANSCRIPTS, userId, "s-late", "main", 150, legacyStretchName(100));
    expect(followedBatch(taken, 150, 65_536).at).toBe(250);

    await env.TRANSCRIPTS.put(key(150), "x".repeat(150));
    const late = await archivedSince(env.TRANSCRIPTS, userId, "s-late", "main", 250, legacyStretchName(200));

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
    const key = (offset: number): string => `${userId}/s-deep/main/${legacyStretchName(offset)}`;
    const from = 4 * MAX_STRETCH_BYTES;
    await env.TRANSCRIPTS.put(key(0), "a");
    await env.TRANSCRIPTS.put(key(from - MAX_STRETCH_BYTES), "b");
    await env.TRANSCRIPTS.put(key(from), "c");

    const runs = await archivedSince(
      env.TRANSCRIPTS,
      userId,
      "s-deep",
      "main",
      from,
      legacyStretchName(from - MAX_STRETCH_BYTES),
    );

    expect(runs.map((run) => run.from)).toEqual([from]);
  });

  // What a beat costs, which is the thing the archive's own shape puts at risk: a stretch keyed by
  // both its ends sits where the sizes of the stretches in front of it put it, so placing the end
  // of a file could be made to read every object of it. The reader's cursor names the stretch it
  // read to the end of, and that is what the page opens past, so a beat over a session of a
  // thousand stretches pays for one listing exactly as a beat over a session of two does.
  it("pays for one page of a listing however many stretches the file was written as", async () => {
    const userId = `bounded-${crypto.randomUUID()}`;
    const prefix = `${userId}/s-wide/main/`;
    const names = Array.from({ length: 1_200 }, (_, span) => stretchName(span * 40, span * 40 + 40));
    for (let at = 0; at < names.length; at += 60) {
      await Promise.all(names.slice(at, at + 60).map((name) => env.TRANSCRIPTS.put(`${prefix}${name}`, "x".repeat(5))));
    }
    let listings = 0;
    const counting = new Proxy(env.TRANSCRIPTS, {
      get(target, key, receiver) {
        if (key !== "list") return Reflect.get(target, key, receiver);
        return (options?: R2ListOptions) => {
          listings += 1;
          return target.list(options);
        };
      },
    });

    const runs = await archivedSince(counting, userId, "s-wide", "main", 1_195 * 5, names[1_194] ?? "");

    expect(listings).toBe(1);
    expect(runs.flatMap((run) => run.reads).map((read) => read.at)).toEqual(names.slice(1_195));
    expect(runs[0]?.from).toBe(1_195 * 5);
  });

  // The one mistake this reading can make. A stretch stored under both its ends sits in the
  // archive where the sizes of the objects in front of it put it, which is nowhere near the number
  // its key names, so a beat that read the cursor as a place in the file would hand the reader
  // ranges of the wrong objects.
  it("places the stretches past a reader of a file whose spans and bodies run to different lengths", async () => {
    const h = await harness();
    const userId = `tailing-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-span");
    await client.archiveSpan("s-span", "main", 0, 400, "one\n");
    await client.archiveSpan("s-span", "main", 400, 900, "two\nthree\n");
    const read = await client.archiveSpan("s-span", "main", 900, 2_000, "four\n");
    expect(read.status).toBe(200);

    // The reader has taken the first two stretches: fourteen bytes of the archive, nine hundred
    // bytes of the file, and the cursor is the first of those.
    const runs = await archivedSince(env.TRANSCRIPTS, userId, "s-span", "main", 14, stretchName(400, 900));

    expect(runs).toEqual([
      { from: 14, to: 19, reads: [{ at: stretchName(900, 2_000), offset: 14, skip: 0, bytes: 5 }] },
    ]);
    expect(followedBatch(runs, 14, 65_536)).toEqual({
      batch: [{ run: 0, at: stretchName(900, 2_000), offset: 14, skip: 0, bytes: 5 }],
      at: 19,
    });
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

  // How many bytes of a session's own transcript the archive holds is the one thing derived off
  // the objects, and the append writes it: the listing it weighed the stretch against already
  // counted them. A storage event that had to count them again would list the whole of the file's
  // prefix on every stretch, which is the length of the session.
  it("writes how much of its own transcript the archive holds as the stretch lands", async () => {
    const h = await harness();
    const userId = `counted-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-count");

    await client.archiveSpan("s-count", "main", 0, 400, "one\n");
    expect(await h.indexMark(userId, "s-count")).toMatchObject({ archived: 4 });
    await client.archiveSpan("s-count", "main", 400, 900, "two\nthree\n");
    expect(await h.indexMark(userId, "s-count")).toMatchObject({ archived: 14 });
    // Refused, so it moved nothing.
    await client.archiveSpan("s-count", "main", 400, 950, "four\n");
    expect(await h.indexMark(userId, "s-count")).toMatchObject({ archived: 14 });
    // A host from before redaction names a place in the archive, so where its stretch ends is the
    // count outright.
    await client.archiveLegacy("s-count", "main", 14, "five\n");
    expect(await h.indexMark(userId, "s-count")).toMatchObject({ archived: 19 });

    // A delegated turn derives nothing, so it writes no row of its own.
    await client.sync("s-turn");
    await client.archiveSpan("s-turn", "agent-7f21", 0, 40, "delegated\n");
    expect(await h.indexMark(userId, "s-turn")).toBeNull();
  });

  // The two key forms share no scale: one names a place in the archive, the other a span of the
  // file whose place in the archive is the sizes of the objects in front of it. A pre-upgrade
  // daemon is answered in archive offsets, so the number it sends next is a number a two-segment
  // key already holds, and reading both would lay the file out as runs with holes between them and
  // point reads inside the wrong objects. So once a span has been seen, the single offsets past it
  // are passed over.
  it("passes over a one-segment key written after a file was keyed by both ends", async () => {
    const userId = `mixed-${crypto.randomUUID()}`;
    const prefix = `${userId}/s-mixed/main/`;
    await env.TRANSCRIPTS.put(`${prefix}${stretchName(0, 40)}`, "aaaa\n");
    await env.TRANSCRIPTS.put(`${prefix}${stretchName(40, 50)}`, "bbbbbbbbbbbbbbb\n");
    await env.TRANSCRIPTS.put(`${prefix}${stretchName(50, 900)}`, "cc\n");
    // What `offset` tells a daemon that has yet to learn to send a span: where the archive reaches,
    // which is twenty-four bytes in. Sent back as a one-segment key it names a place in the file
    // three stretches have already accounted for.
    await env.TRANSCRIPTS.put(`${prefix}${legacyStretchName(24)}`, "never\n");

    const files = await archivedTranscript(env.TRANSCRIPTS, userId, "s-mixed");

    expect(files[0]).toMatchObject({ file: "main", bytes: 24, through: 900, named: true });
    expect(files[0]?.runs.map((run) => [run.from, run.to])).toEqual([[0, 24]]);
    expect(files[0]?.runs[0]?.reads.map((read) => read.at)).toEqual([
      stretchName(0, 40),
      stretchName(40, 50),
      stretchName(50, 900),
    ]);
  });

  // The mirror of it: one key of each form at the same number. Nothing in the archive says which
  // of the two the number means, so reading both would alias one span of the file to one span of
  // the archive and drop an object's bytes out of the file without a word.
  it("passes over a one-segment key at the same number as a span", async () => {
    const userId = `aliased-${crypto.randomUUID()}`;
    const prefix = `${userId}/s-aliased/main/`;
    await env.TRANSCRIPTS.put(`${prefix}${stretchName(0, 50)}`, "aaaa\n");
    await env.TRANSCRIPTS.put(`${prefix}${legacyStretchName(50)}`, "never\n");
    await env.TRANSCRIPTS.put(`${prefix}${stretchName(50, 90)}`, "bb\n");

    const files = await archivedTranscript(env.TRANSCRIPTS, userId, "s-aliased");

    expect(files[0]).toMatchObject({ file: "main", bytes: 8, through: 90, named: true });
    expect(files[0]?.runs[0]?.reads.map((read) => [read.at, read.offset, read.bytes])).toEqual([
      [stretchName(0, 50), 0, 5],
      [stretchName(50, 90), 5, 3],
    ]);
  });

  // The whole of what compressing a stretch has to leave standing. A gzip member says nothing about
  // how much of the file it holds, so the name says it, and every reading of the archive — where a
  // stretch sits in it, how much of the file it holds, how far into the file it reaches — comes off
  // the name. What a reader inflates is the bytes the host read, byte for byte, which is the reason
  // the member is stored as it stands rather than the records being distilled into something else.
  it("stores a stretch gzipped and reads the file back byte for byte", async () => {
    const h = await harness();
    const userId = `packer-${crypto.randomUUID()}`;
    const token = await h.login(await h.invite(`${userId}@example.com`, userId));
    const client = h.clientWithToken(token);
    await client.sync("s-gzip");
    const first = turns(40, "first");
    const second = turns(30, "second");

    expect((await client.archiveGzip("s-gzip", "main", 0, 9_000, first)).status).toBe(200);
    expect((await client.archiveGzip("s-gzip", "main", 9_000, 20_000, second)).status).toBe(200);

    const stored = await env.TRANSCRIPTS.list({ prefix: `${userId}/s-gzip/main/` });
    expect(stored.objects.map((object) => object.key)).toEqual([
      `${userId}/s-gzip/main/${compressedStretchName(0, 9_000, bytes(first))}`,
      `${userId}/s-gzip/main/${compressedStretchName(9_000, 20_000, bytes(second))}`,
    ]);
    // How far into the file the archive reaches, how many of the file's bytes it holds, and the
    // count the index and a following box are weighed against all come off the names and none off
    // the sizes of the objects above. Two writers reaching one place redact the same bytes the same
    // way and gzip them to bodies of whatever lengths their zlib left them, so whichever landed
    // leaves the same count behind.
    expect(await held(await client.transcript("s-gzip"))).toEqual({ main: 20_000 });
    expect(await holds(await client.transcript("s-gzip"))).toEqual({ main: bytes(first) + bytes(second) });
    expect(await h.indexMark(userId, "s-gzip")).toMatchObject({ archived: bytes(first) + bytes(second) });

    // A reader that takes the members is handed them as they stand — not a byte of the archive is
    // touched — and members laid end to end are one gzip stream, which is what it inflates.
    const asStored = await client.readTranscriptGzip("s-gzip", "main");
    expect(asStored.headers.get("content-encoding")).toBe("gzip");
    const members = [await gzipped(first), await gzipped(second)];
    expect(new Uint8Array(await asStored.arrayBuffer())).toEqual(laidEndToEnd(members));
    // One that does not is answered the bytes of the file, which is the same file. A client naming
    // the coding only to refuse it is one of those: `gzip;q=0` asks for the bytes.
    const asBytes = await client.readTranscript("s-gzip", "main");
    expect(asBytes.headers.get("content-encoding")).toBeNull();
    expect(await asBytes.text()).toBe(first + second);
    const refused = await h.send("/v1/sessions/s-gzip/transcript?file=main", {
      headers: { authorization: `Bearer ${token}`, "accept-encoding": "br, gzip;q=0" },
    });
    expect(refused.headers.get("content-encoding")).toBeNull();
    expect(await refused.text()).toBe(first + second);
  });

  // A gzip member says nothing about how long it inflates to, so the append takes the length by
  // inflating it. The length the format trails is no answer: it belongs to the last member of the
  // body, so a body holding two of them would be stored under a name claiming part of what it
  // holds, and every later read of that object — the indexer's, a restore's, a reader's — would
  // break for good. So nothing of the kind is stored and the append says so.
  it("refuses a body holding more than one gzip member", async () => {
    const h = await harness();
    const userId = `doubled-${crypto.randomUUID()}`;
    const token = await h.login(await h.invite(`${userId}@example.com`, userId));
    const client = h.clientWithToken(token);
    await client.sync("s-doubled");
    const members = [await gzipped(turns(10, "first")), await gzipped(turns(10, "second"))];

    const sent = await h.send("/v1/sessions/s-doubled/transcript?file=main&offset=0&through=9000", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/gzip" },
      body: laidEndToEnd(members),
    });

    expect(sent.status).toBe(500);
    expect(await held(await client.transcript("s-doubled"))).toEqual({});
  });

  // One file holding both forms, which is what a host upgrading mid-session leaves behind. Nothing
  // rewrites the stretches already up and nothing backfills them, so the file is read as it stands:
  // the uncompressed stretch is ranged inside, the member is inflated, and the answer is the bytes
  // of the file either way. A reader taking members is not handed that file as one gzip stream,
  // since it is not one.
  it("reads a file holding one stretch stored as it stands and one stored gzipped", async () => {
    const h = await harness();
    const userId = `mixing-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-mixing");
    const plain = turns(20, "plain");
    const packed = turns(20, "packed");

    expect((await client.archiveSpan("s-mixing", "main", 0, 9_000, plain)).status).toBe(200);
    expect((await client.archiveGzip("s-mixing", "main", 9_000, 20_000, packed)).status).toBe(200);

    expect(await held(await client.transcript("s-mixing"))).toEqual({ main: 20_000 });
    expect(await holds(await client.transcript("s-mixing"))).toEqual({ main: bytes(plain) + bytes(packed) });
    const asStored = await client.readTranscriptGzip("s-mixing", "main");
    expect(asStored.headers.get("content-encoding")).toBeNull();
    expect(await asStored.text()).toBe(plain + packed);
    expect(await (await client.readTranscript("s-mixing", "main")).text()).toBe(plain + packed);

    // The reader the index runs wants a window of the prose in the middle of the archive, and a
    // gzip member cannot be opened there: it comes down whole and the window is taken out of what
    // it inflates to. This one opens inside the uncompressed stretch and ends inside the member.
    const from = bytes(plain) - 200;
    const to = bytes(plain) + 300;
    const bite = await readStretch(env.TRANSCRIPTS, userId, "s-mixing", "main", from, to, 1_000);
    const whole = plain + packed;
    expect(bite.through).toBe(to);
    expect(bite.text).toBe(whole.slice(from, to));
  });

  // A box following a live session places the stretches past the reader off one page of a listing,
  // and a member's place in the archive is the lengths of the stretches in front of it — the third
  // segment of each name rather than the size of each object. Reading the sizes would hand the
  // reader ranges of the wrong objects and show it prose the session never said.
  it("places a compressed stretch past a reader following the file", async () => {
    const h = await harness();
    const userId = `trailing-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-trailing");
    const first = turns(20, "first");
    const second = turns(20, "second");
    await client.archiveGzip("s-trailing", "main", 0, 9_000, first);
    await client.archiveGzip("s-trailing", "main", 9_000, 20_000, second);

    const at = bytes(first);
    const runs = await archivedSince(
      env.TRANSCRIPTS,
      userId,
      "s-trailing",
      "main",
      at,
      compressedStretchName(0, 9_000, at),
    );

    const read = { at: compressedStretchName(9_000, 20_000, bytes(second)), offset: at, skip: 0, bytes: bytes(second) };
    expect(runs).toEqual([{ from: at, to: at + bytes(second), reads: [read] }]);
    expect(followedBatch(runs, at, 65_536)).toEqual({ batch: [{ run: 0, ...read }], at: at + bytes(second) });
  });

  // A key can sort past the reader's cursor and still name the span the stretch that cursor names
  // already accounted for, which is what an old host and a new one racing one append leave behind:
  // the same span of the file twice, once as the bytes it was read from and once as a gzip member.
  // The whole-file layout reads the first of those and passes the other over, and a beat reads it
  // the same way — handing the second over would render a stretch the reader already has a second
  // time and place the stretch behind it where no manifest of the file puts it.
  it("passes over a stretch of the span its own cursor names", async () => {
    const userId = `racing-${crypto.randomUUID()}`;
    const prefix = `${userId}/s-racing/main/`;
    const first = turns(20, "first");
    const second = turns(20, "second");
    await env.TRANSCRIPTS.put(`${prefix}${stretchName(0, 9_000)}`, first);
    await env.TRANSCRIPTS.put(`${prefix}${compressedStretchName(0, 9_000, bytes(first))}`, await gzipped(first));
    await env.TRANSCRIPTS.put(`${prefix}${compressedStretchName(9_000, 20_000, bytes(second))}`, await gzipped(second));

    const at = bytes(first);
    const runs = await archivedSince(env.TRANSCRIPTS, userId, "s-racing", "main", at, stretchName(0, 9_000));

    const read = { at: compressedStretchName(9_000, 20_000, bytes(second)), offset: at, skip: 0, bytes: bytes(second) };
    expect(runs).toEqual([{ from: at, to: at + bytes(second), reads: [read] }]);
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
