import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MAX_FOCUS_CHARS,
  SESSION_HISTORY_TTL_MS,
  SESSION_TTL_MS,
  type Session,
  type SessionHistory,
} from "../src/model";
import { listSessionHistory } from "../src/store";
import { type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

interface ListedSession extends Session {
  current: boolean;
}

const listed = async (client: Client): Promise<ListedSession[]> => {
  const response = await client.request("GET", "/v1/sessions");
  expect(response.status).toBe(200);
  const body: { sessions: ListedSession[] } = await response.json();
  return body.sessions;
};

const account = async (h: Harness): Promise<{ laptop: Client; tower: Client }> => {
  const email = await h.invite(`sessions-${crypto.randomUUID()}@example.com`);
  return {
    laptop: h.clientWithToken(await h.login(email, "laptop")),
    tower: h.clientWithToken(await h.login(email, "tower")),
  };
};

interface Member {
  client: Client;
  userId: string;
}

const member = async (h: Harness, label: string): Promise<Member> => {
  const userId = `user-${crypto.randomUUID()}`;
  const email = await h.invite(`${label}-${crypto.randomUUID()}@example.com`, userId);
  return { client: h.clientWithToken(await h.login(email, "laptop")), userId };
};

const history = (who: Member): Promise<SessionHistory[]> => listSessionHistory(env.DB, who.userId, 50);

const historyIds = async (who: Member): Promise<string[]> => (await history(who)).map((session) => session.sessionId);

describe("sessions", () => {
  it("lists every host's sessions, newest activity first, each addressable by its handle", async () => {
    const h = await harness();
    const { laptop, tower } = await account(h);
    const stranger = await h.user("stranger");

    expect((await laptop.sync("s-laptop", { lastActivityAt: h.now() - 60_000 })).status).toBe(204);
    expect((await tower.sync("s-tower", { host: "tower", repo: "", branch: "", lastActivityAt: h.now() })).status).toBe(
      204,
    );
    await stranger.sync("s-stranger");

    const sessions = await listed(laptop);
    expect(sessions.map((session) => [session.host, session.name, session.repo, session.current])).toEqual([
      ["tower", "tower-stow", "", false],
      ["laptop", "laptop-slap", "repo:github.com/mvhenten/recall", true],
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

  it("names each session by its device and the head of its session id, whatever else is live", async () => {
    const h = await harness();
    const { laptop } = await account(h);

    await laptop.sync("9f8a1b2c", { lastActivityAt: h.now() });
    await laptop.sync("c4e21a99", { lastActivityAt: h.now() - 1000 });
    expect((await listed(laptop)).map((session) => session.name)).toEqual(["laptop-9f8a", "laptop-c4e2"]);

    expect((await laptop.request("DELETE", "/v1/sessions/9f8a1b2c")).status).toBe(204);
    expect((await listed(laptop)).map((session) => session.name)).toEqual(["laptop-c4e2"]);
  });

  it("keeps one document per session, so a refreshed focus replaces the last one", async () => {
    const h = await harness();
    const { laptop } = await account(h);

    await laptop.sync("s-1");
    await laptop.sync("s-1", {
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
    await laptop.sync("s-1", { lastActivityAt: h.now() });

    expect((await laptop.request("DELETE", "/v1/sessions/s-1")).status).toBe(204);
    expect((await laptop.request("DELETE", "/v1/sessions/s-1")).status).toBe(404);
    expect(await listed(tower)).toEqual([]);
  });

  it("forgets a session whose host died before it could end it, and only that user's", async () => {
    const h = await harness();
    const { laptop } = await account(h);
    const stranger = await h.user("stranger");
    await laptop.sync("s-crashed", { lastActivityAt: h.now() });
    await stranger.sync("s-also-crashed", { lastActivityAt: h.now() });

    h.tick(SESSION_TTL_MS + 1000);
    expect(await listed(laptop)).toEqual([]);

    h.tick(-(SESSION_TTL_MS + 1000));
    expect(await listed(stranger)).toHaveLength(1);
  });

  it("refuses a document it cannot put on one line", async () => {
    const h = await harness();
    const { laptop } = await account(h);

    expect((await laptop.sync("s-1", { focus: { first: "x".repeat(MAX_FOCUS_CHARS + 1), latest: "" } })).status).toBe(
      400,
    );
    expect((await laptop.sync("s-1", { focus: "just a line" })).status).toBe(400);
    expect((await laptop.sync("s-1", { host: "" })).status).toBe(400);
    expect((await laptop.sync("s-1", { startedAt: "2026-11-02T10:00:00+01:00" })).status).toBe(400);
    expect((await laptop.sync("s-1", { lastActivityAt: -1 })).status).toBe(400);
    expect((await laptop.sync("s-1", { mode: "tmux" })).status).toBe(400);
    expect((await laptop.sync("s-1", { prompts: -1 })).status).toBe(400);
    expect((await laptop.sync("s 1")).status).toBe(400);
    expect((await laptop.request("POST", "/v1/sessions")).status).toBe(405);
  });
});

describe("session history", () => {
  it("keeps what a session was doing once it ends, and once the sweep forgets it", async () => {
    const h = await harness();
    const me = await member(h, "history");

    await me.client.sync("s-ended", { lastActivityAt: h.now() });
    const lastActivityAt = h.tick(60_000);
    await me.client.sync("s-crashed", { lastActivityAt });
    expect((await me.client.request("DELETE", "/v1/sessions/s-ended")).status).toBe(204);
    h.tick(SESSION_TTL_MS + 1000);

    expect(await listed(me.client)).toEqual([]);
    expect(await history(me)).toEqual([
      {
        sessionId: "s-crashed",
        name: "laptop-scra",
        deviceId: expect.any(String),
        host: "laptop",
        cwd: "/home/you/src/recall",
        repo: "repo:github.com/mvhenten/recall",
        branch: "feat/sessions-list",
        commit: "feat(sessions): list every host's sessions",
        startedAt: 1_700_000_000_000,
        lastActivityAt,
        prompts: 3,
        focus: { first: "list every host's sessions", latest: "why is the worker test red" },
        mode: "interactive",
      },
      expect.objectContaining({ sessionId: "s-ended" }),
    ]);
  });

  it("holds one row per session, so the latest sync wins", async () => {
    const h = await harness();
    const me = await member(h, "history");

    await me.client.sync("s-1");
    await me.client.sync("s-1", {
      branch: "feat/session-history",
      prompts: 9,
      focus: { first: "list every host's sessions", latest: "ship it" },
      lastActivityAt: h.now(),
    });

    expect(await history(me)).toMatchObject([
      {
        sessionId: "s-1",
        branch: "feat/session-history",
        prompts: 9,
        focus: { first: "list every host's sessions", latest: "ship it" },
      },
    ]);
  });

  it("shows each user only their own sessions", async () => {
    const h = await harness();
    const me = await member(h, "history");
    const stranger = await member(h, "stranger");

    await me.client.sync("s-mine");
    await stranger.client.sync("s-theirs");

    expect(await historyIds(me)).toEqual(["s-mine"]);
    expect(await historyIds(stranger)).toEqual(["s-theirs"]);
  });

  it("drops a row past the retention window on the next sync, and only the caller's", async () => {
    const h = await harness();
    const me = await member(h, "history");
    const stranger = await member(h, "stranger");

    await me.client.sync("s-ancient", { lastActivityAt: h.now() });
    await stranger.client.sync("s-also-ancient", { lastActivityAt: h.now() });
    h.tick(SESSION_HISTORY_TTL_MS / 2);
    await me.client.sync("s-recent", { lastActivityAt: h.now() });
    h.tick(SESSION_HISTORY_TTL_MS / 2 + 1000);
    await me.client.sync("s-now", { lastActivityAt: h.now() });

    expect(await historyIds(me)).toEqual(["s-now", "s-recent"]);
    expect(await historyIds(stranger)).toEqual(["s-also-ancient"]);
  });
});
