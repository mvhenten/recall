import { describe, expect, it } from "vitest";
import { MAX_FOCUS_CHARS, SESSION_TTL_MS, type Session } from "../src/model";
import { type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

const document = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  host: "laptop",
  cwd: "/home/you/src/recall",
  repo: "repo:github.com/mvhenten/recall",
  branch: "feat/sessions-list",
  commit: "feat(sessions): list every host's sessions",
  startedAt: 1_700_000_000_000,
  lastActivityAt: 1_700_000_060_000,
  prompts: 3,
  focus: { first: "list every host's sessions", latest: "why is the worker test red" },
  mode: "interactive",
  permissionMode: "default",
  pid: 4242,
  ...fields,
});

const sync = (client: Client, sessionId: string, fields: Record<string, unknown> = {}): Promise<Response> =>
  client.request("PUT", `/v1/sessions/${sessionId}`, document(fields));

const listed = async (client: Client): Promise<Session[]> => {
  const response = await client.request("GET", "/v1/sessions");
  expect(response.status).toBe(200);
  const body: { sessions: Session[] } = await response.json();
  return body.sessions;
};

const account = async (h: Harness): Promise<{ laptop: Client; tower: Client }> => {
  const email = await h.invite(`sessions-${crypto.randomUUID()}@example.com`);
  return {
    laptop: h.clientWithToken(await h.login(email, "laptop")),
    tower: h.clientWithToken(await h.login(email, "tower")),
  };
};

describe("sessions", () => {
  it("lists every host's sessions, newest activity first, each addressable by its device name", async () => {
    const h = await harness();
    const { laptop, tower } = await account(h);
    const stranger = await h.user("stranger");

    expect((await sync(laptop, "s-laptop", { lastActivityAt: h.now() - 60_000 })).status).toBe(204);
    expect(
      (await sync(tower, "s-tower", { host: "tower", repo: "", branch: "", lastActivityAt: h.now() })).status,
    ).toBe(204);
    await sync(stranger, "s-stranger");

    const sessions = await listed(laptop);
    expect(sessions.map((session) => [session.host, session.name, session.repo, session.current])).toEqual([
      ["tower", "tower", "", false],
      ["laptop", "laptop", "repo:github.com/mvhenten/recall", true],
    ]);
    expect(sessions[1]).toMatchObject({
      sessionId: "s-laptop",
      cwd: "/home/you/src/recall",
      branch: "feat/sessions-list",
      commit: "feat(sessions): list every host's sessions",
      startedAt: 1_700_000_000_000,
      prompts: 3,
      focus: { first: "list every host's sessions", latest: "why is the worker test red" },
      mode: "interactive",
      permissionMode: "default",
      pid: 4242,
    });
    expect(await listed(stranger)).toHaveLength(1);
  });

  it("keeps one document per session, so a refreshed focus replaces the last one", async () => {
    const h = await harness();
    const { laptop } = await account(h);

    await sync(laptop, "s-1");
    await sync(laptop, "s-1", {
      prompts: 4,
      focus: { first: "list every host's sessions", latest: "ship it" },
      lastActivityAt: h.now(),
    });

    const sessions = await listed(laptop);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.focus).toEqual({ first: "list every host's sessions", latest: "ship it" });
    expect(sessions[0]?.prompts).toBe(4);
  });

  it("drops a session on SessionEnd, so every host stops listing it", async () => {
    const h = await harness();
    const { laptop, tower } = await account(h);
    await sync(laptop, "s-1", { lastActivityAt: h.now() });

    expect((await laptop.request("DELETE", "/v1/sessions/s-1")).status).toBe(204);
    expect((await laptop.request("DELETE", "/v1/sessions/s-1")).status).toBe(404);
    expect(await listed(tower)).toEqual([]);
  });

  it("forgets a session whose host died before it could end it, and only that user's", async () => {
    const h = await harness();
    const { laptop } = await account(h);
    const stranger = await h.user("stranger");
    await sync(laptop, "s-crashed", { lastActivityAt: h.now() });
    await sync(stranger, "s-also-crashed", { lastActivityAt: h.now() });

    h.tick(SESSION_TTL_MS + 1000);
    expect(await listed(laptop)).toEqual([]);

    h.tick(-(SESSION_TTL_MS + 1000));
    expect(await listed(stranger)).toHaveLength(1);
  });

  it("refuses a document it cannot put on one line", async () => {
    const h = await harness();
    const { laptop } = await account(h);

    expect((await sync(laptop, "s-1", { focus: { first: "x".repeat(MAX_FOCUS_CHARS + 1), latest: "" } })).status).toBe(
      400,
    );
    expect((await sync(laptop, "s-1", { focus: "just a line" })).status).toBe(400);
    expect((await sync(laptop, "s-1", { host: "" })).status).toBe(400);
    expect((await sync(laptop, "s-1", { startedAt: "2026-11-02T10:00:00+01:00" })).status).toBe(400);
    expect((await sync(laptop, "s-1", { lastActivityAt: -1 })).status).toBe(400);
    expect((await sync(laptop, "s-1", { mode: "tmux" })).status).toBe(400);
    expect((await sync(laptop, "s-1", { prompts: -1 })).status).toBe(400);
    expect((await sync(laptop, "s 1")).status).toBe(400);
    expect((await laptop.request("POST", "/v1/sessions")).status).toBe(405);
  });
});
