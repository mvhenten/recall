import { describe, expect, it } from "vitest";
import { DAY_MS, USAGE_RETENTION_MS } from "../src/model";
import { harness, tenantRows } from "./harness";

// How many records of each file the archive holds, which is the one count that is a place in the
// file on disk as well as in the archive.
const records = async (response: Response): Promise<Record<string, number>> => {
  expect(response.status).toBe(200);
  const { files } = (await response.json()) as { files: Array<{ file: string; records: number }> };
  return Object.fromEntries(files.map(({ file, records: held }) => [file, held]));
};

const counted = async (response: Response): Promise<string[]> => {
  expect(response.status).toBe(200);
  const { counted: files } = (await response.json()) as { counted: string[] };
  return files;
};

const rollup = (userId: string): Promise<Array<Record<string, unknown>>> =>
  tenantRows(
    userId,
    "SELECT day, model, prompts, input_tokens FROM usage_daily WHERE user_id = ? ORDER BY day, model",
    userId,
  );

describe("transcript archive", () => {
  it("takes a session's files an append at a time and says how many records each holds", async () => {
    const h = await harness();
    const client = await h.user("archivist");
    await client.sync("s-1");

    expect(await records(await client.transcript("s-1"))).toEqual({});
    expect((await client.v2.records("s-1", "main", 0, ["one", "two"])).status).toBe(200);
    expect((await client.v2.records("s-1", "main", 2, ["three"])).status).toBe(200);
    expect((await client.v2.records("s-1", "agent-7f21", 0, ["delegated"])).status).toBe(200);

    expect(await records(await client.transcript("s-1"))).toEqual({ main: 3, "agent-7f21": 1 });
  });

  it("answers no caller the session does not belong to", async () => {
    const h = await harness();
    const owner = await h.user("owner");
    const stranger = await h.user("stranger");
    await owner.sync("s-4");
    expect((await owner.v2.records("s-4", "main", 0, ["one"])).status).toBe(200);

    expect((await stranger.transcript("s-4")).status).toBe(404);
    expect((await owner.transcript("s-unknown")).status).toBe(404);
    const anonymous = await h.send("/v2/sessions/s-4/transcript");
    expect(anonymous.status).toBe(401);

    expect(await records(await owner.transcript("s-4"))).toEqual({ main: 1 });
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

  // A session that ended is still a session on record, so its archive answers and takes more
  // prose. Only the live row moved; the files did not.
  it("keeps a session's files once its row has moved to the history", async () => {
    const h = await harness();
    const client = await h.user("historian");
    await client.sync("s-5");
    expect((await client.v2.records("s-5", "main", 0, ["one"])).status).toBe(200);
    expect((await client.request("DELETE", "/v2/sessions/s-5")).status).toBe(204);

    expect((await client.v2.records("s-5", "main", 1, ["two"])).status).toBe(200);
    expect(await (await client.readTranscript("s-5", "main")).text()).toBe("one\ntwo\n");
  });
});
