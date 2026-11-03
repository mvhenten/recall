import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY_MS, USAGE_RETENTION_MS } from "../src/model";
import { MAX_CHUNK_BYTES } from "../src/transcripts";
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

  // The whole of what a retry costs now that nothing is claimed: a stretch is stored under the
  // offset it was sent at, so sending it again writes that same object rather than a second copy
  // of the same lines beside it.
  it("takes a stretch sent twice as the one stretch it is", async () => {
    const h = await harness();
    const client = await h.user("retrier");
    await client.sync("s-2");
    await client.archive("s-2", "main", 0, "one\ntwo\n");

    const again = await client.archive("s-2", "main", 0, "one\ntwo\n");

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ file: "main", offset: 8 });
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

  // Two writers reaching one file at the same offset — the listener's beat and a session ending.
  // Neither is refused and one object is left behind, so the file is still a run of stretches
  // with nothing written over the top of anything; the reading that decides where the next
  // stretch goes counts that object rather than trusting what either writer was told.
  it("leaves two writers at the same offset one stretch, and says what it holds", async () => {
    const h = await harness();
    const userId = `racer-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-race");

    const [longer, shorter] = await Promise.all([
      client.archive("s-race", "main", 0, "fourteen bytes"),
      client.archive("s-race", "main", 0, "four"),
    ]);

    expect([longer.status, shorter.status]).toEqual([200, 200]);
    const stored = await env.TRANSCRIPTS.list({ prefix: `${userId}/s-race/main/` });
    expect(stored.objects).toHaveLength(1);
    const bytes = (await held(await client.transcript("s-race"))).main ?? 0;
    expect(bytes).toBe(stored.objects[0]?.size);
    expect((await client.archive("s-race", "main", bytes, "!")).status).toBe(200);
    expect((await held(await client.transcript("s-race"))).main).toBe(bytes + 1);
  });

  // The one reading kept off the objects, and the only thing that can disagree with them. It
  // follows the storage event, and a mark left ahead of the archive — by a write that was
  // announced and then lost — is written over by the listing that found it out.
  it("moves the archive mark off the event, and puts one that disagrees back", async () => {
    const h = await harness();
    const userId = `marked-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-mark");
    await client.archive("s-mark", "main", 0, "one\ntwo\n");

    expect(await h.indexMark(userId, "s-mark")).toBeNull();
    await h.deliver();
    expect(await h.indexMark(userId, "s-mark")).toMatchObject({ archived: 8, bytes: 8 });

    await env.DB.prepare("UPDATE session_index SET archived = 9999 WHERE user_id = ? AND session_id = ?")
      .bind(userId, "s-mark")
      .run();
    expect(await held(await client.transcript("s-mark"))).toEqual({ main: 8 });

    expect(await h.indexMark(userId, "s-mark")).toMatchObject({ archived: 8 });
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
