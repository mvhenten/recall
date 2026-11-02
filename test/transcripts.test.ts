import { describe, expect, it } from "vitest";
import { MAX_CHUNK_BYTES } from "../src/transcripts";
import { harness } from "./harness";

const held = async (response: Response): Promise<Record<string, number>> => {
  expect(response.status).toBe(200);
  const { files } = (await response.json()) as { files: Array<{ file: string; bytes: number }> };
  return Object.fromEntries(files.map(({ file, bytes }) => [file, bytes]));
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
