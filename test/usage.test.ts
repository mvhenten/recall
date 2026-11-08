import { describe, expect, it } from "vitest";
import { MAX_USAGE_TOKENS, USAGE_EPOCH, USAGE_RETENTION_MS, usageDay } from "../src/model";
import { type Client, harness, tenantRows } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

interface DailyRow {
  day: string;
  host: string;
  repo: string;
  account: string;
  provider: string;
  model: string;
  prompts: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
}

const DAY_ONE = Date.UTC(2026, 10, 1, 23, 30);
const DAY_TWO = Date.UTC(2026, 10, 2, 0, 30);

// A delta may not be dated ahead of now, so the clock stands on the later of the two days these
// tests straddle before any of them is sent.
const onDayTwo = async (): Promise<Harness> => {
  const h = await harness();
  h.tick(DAY_TWO - h.now());
  return h;
};

const account = async (h: Harness, label: string): Promise<{ userId: string; client: Client }> => {
  const userId = `${label}-${crypto.randomUUID()}`;
  const email = await h.invite(`${label}-${crypto.randomUUID()}@example.com`, userId);
  return { userId, client: h.clientWithToken(await h.login(email, "laptop")) };
};

const daily = (userId: string): Promise<DailyRow[]> =>
  tenantRows<DailyRow>(
    userId,
    `SELECT day, host, repo, account, provider, model, prompts, input_tokens, output_tokens,
       cache_write_tokens, cache_read_tokens
     FROM usage_daily WHERE user_id = ? ORDER BY day, model`,
    userId,
  );

const events = (userId: string): Promise<Array<{ session_id: string; seq: number; at: number }>> =>
  tenantRows<{ session_id: string; seq: number; at: number }>(
    userId,
    "SELECT session_id, seq, at FROM usage_events WHERE user_id = ? ORDER BY session_id, seq",
    userId,
  );

describe("usage", () => {
  it("counts a delta once however often the client resends it", async () => {
    const h = await onDayTwo();
    const { userId, client } = await account(h, "usage");
    await client.sync("s-1");

    expect((await client.usage("s-1", { seq: 1, at: DAY_ONE })).status).toBe(204);
    expect((await client.usage("s-1", { seq: 1, at: DAY_ONE })).status).toBe(204);

    expect(await events(userId)).toEqual([{ session_id: "s-1", seq: 1, at: DAY_ONE }]);
    expect(await daily(userId)).toEqual([
      {
        day: "2026-11-01",
        host: "laptop",
        repo: "repo:github.com/mvhenten/recall",
        account: "work",
        provider: "anthropic",
        model: "claude-opus-4",
        prompts: 1,
        input_tokens: 120,
        output_tokens: 40,
        cache_write_tokens: 900,
        cache_read_tokens: 8_000,
      },
    ]);
  });

  it("sums a session's deltas into the day each one ran, splitting at midnight", async () => {
    const h = await onDayTwo();
    const { userId, client } = await account(h, "usage");
    await client.sync("s-1");

    await client.usage("s-1", { seq: 1, at: DAY_ONE, inputTokens: 100, outputTokens: 10 });
    await client.usage("s-1", { seq: 2, at: DAY_ONE + 60_000, inputTokens: 5, outputTokens: 1 });
    await client.usage("s-1", { seq: 3, at: DAY_TWO, inputTokens: 7, outputTokens: 2 });
    await client.usage("s-1", { seq: 4, at: DAY_TWO, model: "claude-haiku-4", inputTokens: 3, outputTokens: 4 });

    expect(
      (await daily(userId)).map((row) => [row.day, row.model, row.prompts, row.input_tokens, row.output_tokens]),
    ).toEqual([
      ["2026-11-01", "claude-opus-4", 2, 105, 11],
      ["2026-11-02", "claude-haiku-4", 1, 3, 4],
      ["2026-11-02", "claude-opus-4", 1, 7, 2],
    ]);
  });

  it("counts a delta from its own host and repo, even when the session is gone", async () => {
    const h = await onDayTwo();
    const { userId, client } = await account(h, "usage");

    const response = await client.usage("s-ended", {
      host: "tower",
      repo: "repo:github.com/mvhenten/other",
      at: DAY_ONE,
    });

    expect(response.status).toBe(204);
    expect((await daily(userId)).map((row) => [row.host, row.repo])).toEqual([
      ["tower", "repo:github.com/mvhenten/other"],
    ]);
  });

  it("keeps the first numbers for a seq when a retry disagrees", async () => {
    const h = await onDayTwo();
    const { userId, client } = await account(h, "usage");

    expect((await client.usage("s-1", { seq: 1, at: DAY_ONE, inputTokens: 120 })).status).toBe(204);
    expect((await client.usage("s-1", { seq: 1, at: DAY_ONE, inputTokens: 999 })).status).toBe(204);

    expect((await events(userId)).map((row) => row.seq)).toEqual([1]);
    expect((await daily(userId)).map((row) => row.input_tokens)).toEqual([120]);
  });

  it("refuses a delta it cannot count", async () => {
    const h = await harness();
    const { userId, client } = await account(h, "usage");
    await client.sync("s-1");

    expect((await client.usage("s-1", { seq: -1 })).status).toBe(400);
    expect((await client.usage("s-1", { seq: 1.5 })).status).toBe(400);
    expect((await client.usage("s-1", { host: "" })).status).toBe(400);
    expect((await client.usage("s-1", { repo: 7 })).status).toBe(400);
    expect((await client.usage("s-1", { provider: "" })).status).toBe(400);
    expect((await client.usage("s-1", { account: "" })).status).toBe(400);
    expect((await client.usage("s-1", { model: "" })).status).toBe(400);
    expect((await client.usage("s-1", { account: 7 })).status).toBe(400);
    expect((await client.usage("s-1", { inputTokens: -1 })).status).toBe(400);
    expect((await client.usage("s-1", { outputTokens: MAX_USAGE_TOKENS + 1 })).status).toBe(400);
    expect((await client.usage("s-1", { cacheWriteTokens: "900" })).status).toBe(400);
    expect((await client.usage("s-1", { cacheReadTokens: null })).status).toBe(400);
    expect((await client.usage("s-1", { at: "2026-11-01T23:30:00+00:00" })).status).toBe(400);
    expect((await client.usage("s-1", { at: 0 })).status).toBe(400);
    expect((await client.usage("s-1", { at: USAGE_EPOCH - 1 })).status).toBe(400);
    expect((await client.usage("s-1", { at: h.now() + 2 * 86_400_000 })).status).toBe(400);
    expect((await client.request("GET", "/v1/sessions/s-1/usage")).status).toBe(405);
    expect((await client.request("POST", "/v1/sessions/s-1/cost", {})).status).toBe(404);
    expect((await client.request("POST", "/v1/memories/a-memory/usage", {})).status).toBe(404);

    expect(await events(userId)).toEqual([]);
    expect(await daily(userId)).toEqual([]);
  });

  it("keeps one account's usage out of another's, whatever session id it names", async () => {
    const h = await onDayTwo();
    const mine = await account(h, "mine");
    const theirs = await account(h, "theirs");

    expect((await mine.client.usage("s-shared", { seq: 1, at: DAY_ONE })).status).toBe(204);
    expect((await theirs.client.usage("s-shared", { seq: 1, at: DAY_ONE, inputTokens: 1 })).status).toBe(204);

    expect((await events(mine.userId)).map((row) => row.session_id)).toEqual(["s-shared"]);
    expect((await events(theirs.userId)).map((row) => row.session_id)).toEqual(["s-shared"]);
    expect((await daily(mine.userId))[0]?.input_tokens).toBe(120);
    expect((await daily(theirs.userId))[0]?.input_tokens).toBe(1);
  });

  it("sweeps the caller's events past the retention window and leaves the rollup and everyone else alone", async () => {
    const h = await harness();
    const mine = await account(h, "mine");
    const theirs = await account(h, "theirs");
    await mine.client.sync("s-1");
    await theirs.client.sync("s-2");
    const early = h.now();

    await mine.client.usage("s-1", { seq: 1, at: early, inputTokens: 11 });
    await theirs.client.usage("s-2", { seq: 1, at: early, inputTokens: 22 });
    const late = h.tick(USAGE_RETENTION_MS + 86_400_000);
    await mine.client.usage("s-1", { seq: 2, at: late, inputTokens: 33 });

    expect((await events(mine.userId)).map((row) => row.seq)).toEqual([2]);
    expect((await events(theirs.userId)).map((row) => row.seq)).toEqual([1]);
    expect((await daily(mine.userId)).map((row) => [row.day, row.input_tokens])).toEqual([
      [usageDay(early), 11],
      [usageDay(late), 33],
    ]);
  });
});
