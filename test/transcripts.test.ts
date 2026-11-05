import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY_MS, USAGE_RETENTION_MS } from "../src/model";
import { followedBatch } from "../src/transcript-plan";
import { archivedSince, MAX_CHUNK_BYTES } from "../src/transcripts";
import { harness } from "./harness";

const held = async (response: Response): Promise<Record<string, number>> => {
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
    expect(await first.json()).toEqual({ file: "main", offset: 8 });
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
    expect(await again.json()).toMatchObject({ offset: 8 });
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

  // Two writers reaching one file at the same offset — the listener's beat and a session ending —
  // holding stretches of different lengths, because they read the file at different instants.
  // Neither re-reads where the file ends afterwards: each takes what its own append answered and
  // sends the next stretch from there. One object lands and the other writer is answered with
  // where the file reaches, so both carry on from the same place and no run of bytes is left in
  // no object at all.
  it("lets one of two writers at the same offset win, and sends the other on from the end", async () => {
    const h = await harness();
    const userId = `racer-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-race");

    const [longer, shorter] = await Promise.all([
      client.archive("s-race", "main", 0, "fourteen bytes"),
      client.archive("s-race", "main", 0, "four"),
    ]);

    expect([longer.status, shorter.status].sort()).toEqual([200, 409]);
    const stored = await env.TRANSCRIPTS.list({ prefix: `${userId}/s-race/main/` });
    expect(stored.objects).toHaveLength(1);
    const [told, also] = (await Promise.all([longer.json(), shorter.json()])) as Array<{ offset: number }>;
    expect(told?.offset).toBe(stored.objects[0]?.size);
    expect(also?.offset).toBe(told?.offset);
    expect((await client.archive("s-race", "main", told?.offset ?? 0, "!")).status).toBe(200);
    expect((await held(await client.transcript("s-race"))).main).toBe((told?.offset ?? 0) + 1);
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
      batch: [{ run: 0, offset: 50, skip: 50, bytes: 100 }],
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
      batch: [{ run: 0, offset: 150, skip: 100, bytes: 50 }],
      at: 300,
    });
  });

  // One stretch back and no further, whatever the file has run to: no stretch holds more than
  // MAX_CHUNK_BYTES, so a key below that floor cannot reach past the reader and listing it would
  // only cost a beat the length of the session.
  it("reaches back one stretch and leaves the rest of a long file alone", async () => {
    const userId = `deep-${crypto.randomUUID()}`;
    const key = (offset: number): string => `${userId}/s-deep/main/${String(offset).padStart(16, "0")}`;
    const from = 4 * MAX_CHUNK_BYTES;
    await env.TRANSCRIPTS.put(key(from - MAX_CHUNK_BYTES - 1), "a");
    await env.TRANSCRIPTS.put(key(from - MAX_CHUNK_BYTES), "b");
    await env.TRANSCRIPTS.put(key(from), "c");

    const runs = await archivedSince(env.TRANSCRIPTS, userId, "s-deep", "main", from);

    expect(runs.map((run) => run.from)).toEqual([from - MAX_CHUNK_BYTES, from]);
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
