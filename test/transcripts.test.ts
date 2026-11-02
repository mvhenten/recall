import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY_MS, USAGE_RETENTION_MS } from "../src/model";
import { MAX_CHUNK_BYTES } from "../src/transcripts";
import { harness } from "./harness";

// Where cli/src/backfill.rs numbers a whole-file reading from, clear of the chunk numbers a
// running session's hooks hand out as it runs.
const BACKFILL_BASE = 2 ** 40;

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

  it("refuses a stretch that does not start where the file ends, and says where it does", async () => {
    const h = await harness();
    const client = await h.user("retrier");
    await client.sync("s-2");
    await client.archive("s-2", "main", 0, "one\ntwo\n");

    const again = await client.archive("s-2", "main", 0, "one\ntwo\n");

    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ offset: 8 });
    expect(await held(await client.transcript("s-2"))).toEqual({ main: 8 });
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

  // What `recall sessions --backfill` does with one past session, in the order it does it: every
  // file's tokens, the row, the end, then the files. A session the service has never seen has to
  // survive that whole order, which is the run's first step on any host.
  const backfill = async (
    client: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>["user"]>>,
    sessionId: string,
    reading: Array<Record<string, unknown>>,
  ): Promise<void> => {
    for (const event of reading) {
      expect((await client.usage(sessionId, event)).status).toBe(204);
    }
    expect((await client.sync(sessionId)).status).toBe(204);
    expect((await client.request("DELETE", `/v1/sessions/${sessionId}`)).status).toBe(204);
    // The archive resumes where the service says the file ends, as cli/src/transcripts.rs does,
    // so a run that repeats writes no line twice.
    const at = (await held(await client.transcript(sessionId))).main ?? 0;
    const body = "one\ntwo\n".slice(at);
    if (body !== "") expect((await client.archive(sessionId, "main", at, body)).status).toBe(200);
  };

  const READING = [
    { seq: BACKFILL_BASE, model: "claude-opus-4", inputTokens: 150, prompts: 2, durable: true, files: ["main"] },
    { seq: BACKFILL_BASE + 1, model: "claude-haiku-4", inputTokens: 5, prompts: 0, durable: true, files: ["main"] },
  ];

  it("takes a backfill of a session it has never seen, from the first call to the archive", async () => {
    const h = await harness();
    const userId = `backfiller-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));

    await backfill(client, "s-unseen", READING);

    expect(await held(await client.transcript("s-unseen"))).toEqual({ main: 8 });
    expect(await rollup(userId)).toHaveLength(2);
  });

  it("counts a backfill's reading once however long after the first the second arrives", async () => {
    const h = await harness();
    const userId = `replayer-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await backfill(client, "s-replayed", READING);
    const once = await rollup(userId);
    expect(once).toHaveLength(2);

    // Past the window the raw events are swept at, which is the only thing that could have
    // absorbed the repeat if the rows were not kept.
    h.tick(USAGE_RETENTION_MS + DAY_MS);
    await backfill(client, "s-replayed", READING);
    await backfill(client, "s-replayed", READING);

    expect(await rollup(userId)).toEqual(once);
  });

  // The control for the test above: a delta a running session sent is swept at two weeks, and
  // once the row is gone the same chunk number counts again. Keeping the rows a backfill writes
  // is the whole of what stops that happening to a reading it will send again.
  it("sweeps a delta a running session sent, so the same chunk number counts again", async () => {
    const h = await harness();
    const userId = `sweeper-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    const delta = { seq: 0, model: "claude-opus-4", inputTokens: 150 };
    await client.sync("s-live");
    expect((await client.usage("s-live", delta)).status).toBe(204);
    const once = await rollup(userId);

    h.tick(USAGE_RETENTION_MS + DAY_MS);
    // The pass that sweeps the row is the one this delta arrives on, so the one after it is the
    // first to find the row gone.
    expect((await client.usage("s-live", delta)).status).toBe(204);
    expect(await rollup(userId)).toEqual(once);
    expect((await client.usage("s-live", delta)).status).toBe(204);

    expect(await rollup(userId)).not.toEqual(once);
  });

  // The half the archive exists for. A host that backfilled before the counter read delegated
  // turns has its own transcripts counted and those files counted nowhere, and that is most of
  // what its sessions spent. The run that recovers them asks which files are counted, which is a
  // usage fact and not an archive one.
  it("recovers the delegated turns of a session on record, and counts them once", async () => {
    const h = await harness();
    const userId = `recoverer-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await backfill(client, "s-old", READING);
    const before = await rollup(userId);
    expect(await counted(await client.transcript("s-old"))).toEqual(["main"]);

    const turn = {
      seq: BACKFILL_BASE + 7 * 2 ** 16,
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
