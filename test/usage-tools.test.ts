import { describe, expect, it } from "vitest";
import type { SessionUsageReport, UsageReport } from "../src/tools";
import { harness } from "./harness";

const DAY_ONE = Date.UTC(2026, 10, 1, 12, 0);
const DAY_TWO = Date.UTC(2026, 10, 2, 12, 0);

const RECALL = "repo:github.com/mvhenten/recall";
const READER = "repo:github.com/remit-mail/reader";

// Two sessions on one host, in two repositories, over two days: one priced model on each day and
// one the price table has never heard of, which is what a reading has to keep apart from free.
const spending = async () => {
  const h = await harness();
  h.tick(DAY_TWO - h.now());
  const email = await h.invite(`usage-${crypto.randomUUID()}@example.com`);
  const mcp = await h.connector(email);
  const client = h.clientWithToken(await h.login(email, "laptop"));

  expect(
    (
      await client.sync("s-recall", {
        host: "laptop",
        cwd: "/home/you/src/recall",
        repo: RECALL,
        startedAt: DAY_ONE,
        lastActivityAt: DAY_TWO - 1_000,
        prompts: 9,
      })
    ).status,
  ).toBe(204);
  expect(
    (
      await client.sync("s-reader", {
        host: "laptop",
        cwd: "/home/you/src/reader",
        repo: READER,
        startedAt: DAY_TWO,
        lastActivityAt: DAY_TWO,
        prompts: 4,
      })
    ).status,
  ).toBe(204);

  const delta = async (sessionId: string, fields: Record<string, unknown>): Promise<void> => {
    expect((await client.usage(sessionId, fields)).status).toBe(204);
  };
  await delta("s-recall", {
    seq: 1,
    at: DAY_ONE,
    repo: RECALL,
    model: "claude-opus-4",
    prompts: 2,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheWriteTokens: 200_000,
    cacheReadTokens: 4_000_000,
  });
  await delta("s-recall", {
    seq: 2,
    at: DAY_TWO,
    repo: RECALL,
    model: "claude-sonnet-4",
    prompts: 1,
    inputTokens: 200_000,
    outputTokens: 20_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 800_000,
  });
  await delta("s-reader", {
    seq: 1,
    at: DAY_TWO,
    repo: READER,
    provider: "zai",
    model: "glm-5.3",
    prompts: 1,
    inputTokens: 50_000,
    outputTokens: 10_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  });
  return { h, mcp };
};

type Connector = Awaited<ReturnType<typeof spending>>["mcp"];

const usage = async (mcp: Connector, args: Record<string, unknown> = {}): Promise<UsageReport> =>
  (await mcp.json("recall_usage", args)) as UsageReport;

describe("usage tools", () => {
  // The four classes never fold into one number: a cache read costs a tenth of fresh input, so a
  // total alone cannot answer what a gateway charging per token would have cost.
  it("reports the token classes apart, with the cost the dashboard prices", async () => {
    const { mcp } = await spending();
    const report = await usage(mcp);

    expect([report.from, report.to, report.period, report.repo]).toEqual(["2026-10-04", "2026-11-02", "day", ""]);
    expect(report.totals).toEqual({
      inputTokens: 1_250_000,
      outputTokens: 130_000,
      cacheReadTokens: 4_800_000,
      cacheWriteTokens: 200_000,
      totalTokens: 6_380_000,
      cacheHitRate: 0.7934,
      cost: 11.89,
      costIsFloor: true,
      unpricedModels: ["glm-5.3"],
      turns: 4,
    });
    expect(report.buckets.map((bucket) => [bucket.bucket, bucket.cost, bucket.turns])).toEqual([
      ["2026-11-01", 10.75, 2],
      ["2026-11-02", 1.14, 2],
    ]);
    expect(report.repos.map((repo) => [repo.repo, repo.cost, repo.totalTokens])).toEqual([
      [RECALL, 11.89, 6_320_000],
      [READER, null, 60_000],
    ]);
  });

  // An unpriced model is counted and left out of the money rather than being read as free, and a
  // breakdown that mixes the two says the cost is a floor.
  it("prices nothing it has no price for", async () => {
    const { mcp } = await spending();
    const report = await usage(mcp, { repo: "reader" });

    expect(report.repo).toBe(READER);
    expect(report.repos.map((repo) => repo.repo)).toEqual([READER]);
    expect(report.models).toEqual([
      {
        provider: "zai",
        model: "glm-5.3",
        inputTokens: 50_000,
        outputTokens: 10_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 60_000,
        cacheHitRate: 0,
        cost: null,
        costIsFloor: false,
        unpricedModels: ["glm-5.3"],
      },
    ]);
    expect(report.totals.cost).toBeNull();
    expect(report.totals.costIsFloor).toBe(false);
  });

  it("buckets a window by month and narrows it by day", async () => {
    const { mcp } = await spending();

    const monthly = await usage(mcp, { period: "month" });
    expect(monthly.buckets.map((bucket) => [bucket.bucket, bucket.cost])).toEqual([["2026-11", 11.89]]);

    const firstDay = await usage(mcp, { from: "2026-11-01", to: "2026-11-01" });
    expect(firstDay.buckets.map((bucket) => bucket.bucket)).toEqual(["2026-11-01"]);
    expect(firstDay.totals.cost).toBe(10.75);
  });

  it("refuses a repository it holds no reading for, and a window that runs backwards", async () => {
    const { mcp } = await spending();

    const missing = await mcp.tool("recall_usage", { repo: "ledger" }).catch((error: Error) => error.message);
    expect(missing).toContain("no repository named ledger");
    expect(missing).toContain("github.com/remit-mail/reader");

    const backwards = await mcp
      .tool("recall_usage", { from: "2026-11-02", to: "2026-11-01" })
      .catch((error: Error) => error.message);
    expect(backwards).toBe("recall: from 2026-11-02 falls after to 2026-11-01");
  });

  it("answers what each session spent, where it ran and how many turns it took", async () => {
    const { mcp } = await spending();
    const report = (await mcp.json("recall_session_usage")) as { sessions: SessionUsageReport[] };

    expect(
      report.sessions.map((session) => [session.sessionId, session.repo, session.cwd, session.host, session.turns]),
    ).toEqual([
      ["s-reader", READER, "/home/you/src/reader", "laptop", 4],
      ["s-recall", RECALL, "/home/you/src/recall", "laptop", 9],
    ]);

    const [, recall] = report.sessions;
    expect(recall?.startedAt).toBe("2026-11-01T12:00:00.000Z");
    expect(recall?.lastActivityAt).toBe("2026-11-02T11:59:59.000Z");
    expect(recall?.accounts).toEqual(["work"]);
    expect(recall?.cost).toBe(11.89);
    expect(recall?.cacheReadTokens).toBe(4_800_000);
    expect(recall?.cacheWriteTokens).toBe(200_000);
    expect(recall?.models.map((model) => [model.model, model.cost])).toEqual([
      ["claude-opus-4", 10.75],
      ["claude-sonnet-4", 1.14],
    ]);

    const one = (await mcp.json("recall_session_usage", { session: "s-reader" })) as {
      sessions: SessionUsageReport[];
    };
    expect(one.sessions.map((session) => session.sessionId)).toEqual(["s-reader"]);
    expect(one.sessions[0]?.cost).toBeNull();
  });
});
