import { describe, expect, it } from "vitest";
import { type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

const email = (label: string): string => `${label}-${crypto.randomUUID()}@example.com`;

const open = (h: Harness, path: string, assertion: string | null): Promise<Response> =>
  h.send(path, { headers: assertion === null ? {} : { "cf-access-jwt-assertion": assertion } });

const signedIn = async (h: Harness): Promise<{ email: string; assertion: string }> => {
  const address = await h.invite(email("owner"));
  return { email: address, assertion: await h.assertionFor(address) };
};

describe("the root path", () => {
  it("sends a browser to the dashboard", async () => {
    const h = await harness();
    const response = await h.send("/", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(response.headers.get("vary")).toBe("accept");
  });

  it("keeps answering 404 JSON to every client that does not ask for HTML", async () => {
    const h = await harness();
    for (const accept of [undefined, "*/*", "application/json"]) {
      const response = await h.send("/", accept === undefined ? {} : { headers: { accept } });
      expect(response.status).toBe(404);
      expect(response.headers.get("vary")).toBe("accept");
      expect(await response.json()).toEqual({ error: "not found" });
    }
  });
});

describe("the dashboard", () => {
  it("renders a tab of the shell and links to the others", async () => {
    const h = await harness();
    const owner = await signedIn(h);
    const response = await open(h, "/dashboard/stats", owner.assertion);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain(owner.email);
    expect(html).toContain('<a href="/dashboard/stats" aria-current="page">Stats</a>');
    for (const [path, label] of [
      ["/dashboard", "Sessions"],
      ["/dashboard/memory", "Memory"],
      ["/dashboard/insights", "Insights"],
    ]) {
      expect(html).toContain(`<a href="${path}">${label}</a>`);
    }
  });

  it("has no page at an unknown dashboard address", async () => {
    const h = await harness();
    const owner = await signedIn(h);
    expect((await open(h, "/dashboard/costs", owner.assertion)).status).toBe(404);
  });

  it("refuses a request that carries no Access assertion", async () => {
    const h = await harness();
    const response = await open(h, "/dashboard", null);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('<a href="/dashboard">Sign in again</a>');
  });

  it("refuses a verified email that is not invited", async () => {
    const h = await harness();
    const stranger = email("stranger");
    const response = await open(h, "/dashboard", await h.assertionFor(stranger));
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain(stranger);
    expect(html).toContain('<a href="/dashboard">Sign in again</a>');
  });

  it("serves the dashboard on GET only", async () => {
    const h = await harness();
    const owner = await signedIn(h);
    const response = await h.send("/dashboard", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": owner.assertion },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});

const sync = (client: Client, sessionId: string, fields: Record<string, unknown>): Promise<Response> =>
  client.request("PUT", `/v1/sessions/${sessionId}`, {
    host: "laptop",
    cwd: "/home/you/src/recall",
    repo: "repo:github.com/mvhenten/recall",
    branch: "feat/dashboard-sessions",
    commit: "feat(dashboard): show the live sessions of every host",
    prompts: 3,
    focus: { first: "list the sessions", latest: "why is the worker test red" },
    mode: "interactive",
    permissionMode: "default",
    pid: 4242,
    ...fields,
  });

const hosts = async (h: Harness): Promise<{ assertion: string; laptop: Client; tower: Client }> => {
  const address = await h.invite(email("owner"));
  return {
    assertion: await h.assertionFor(address),
    laptop: h.clientWithToken(await h.login(address, "laptop")),
    tower: h.clientWithToken(await h.login(address, "tower")),
  };
};

const sessionsTab = async (h: Harness, assertion: string | null): Promise<string> => {
  const response = await open(h, "/dashboard", assertion);
  return response.text();
};

describe("the sessions tab", () => {
  it("lists every host's session, busy first, with its handle, host, scope and focus", async () => {
    const h = await harness();
    const owner = await hosts(h);
    const stranger = h.clientWithToken(await h.login(await h.invite(email("stranger")), "nomad"));
    const now = h.now();
    await sync(owner.laptop, "9f8a1b2c", { startedAt: now - 720_000, lastActivityAt: now - 60_000 });
    await sync(owner.tower, "c4e21a99", {
      host: "tower",
      repo: "",
      branch: "",
      prompts: 1,
      focus: { first: "draft the release notes", latest: "" },
      startedAt: now - 10_800_000,
      lastActivityAt: now - 840_000,
    });
    await sync(stranger, "aa11bb22", { startedAt: now, lastActivityAt: now });

    const html = await sessionsTab(h, owner.assertion);
    expect(html).toContain(
      '<p class="handle">laptop-9f8a <span class="host">laptop</span></p>\n' +
        '<p class="state busy"><span class="dot"></span>busy</p>\n' +
        '<p class="focus">list the sessions<span class="then"> → </span>why is the worker test red</p>\n' +
        '<p class="meta">repo:github.com/mvhenten/recall@feat/dashboard-sessions · 12m · 3 prompts</p>',
    );
    expect(html).toContain(
      '<p class="handle">tower-c4e2 <span class="host">tower</span></p>\n' +
        '<p class="state"><span class="dot"></span>idle 14m</p>\n' +
        '<p class="focus">draft the release notes</p>\n' +
        '<p class="meta">global · 3h · 1 prompt</p>',
    );
    expect(html.indexOf("laptop-9f8a")).toBeLessThan(html.indexOf("tower-c4e2"));
    expect(html).not.toContain("nomad");
  });

  it("reads busy for five minutes after the last prompt, idle from then on", async () => {
    const h = await harness();
    const owner = await hosts(h);
    const now = h.now();
    await sync(owner.laptop, "aaa10000", { startedAt: now - 600_000, lastActivityAt: now - 299_999 });
    await sync(owner.laptop, "bbb20000", { startedAt: now - 600_000, lastActivityAt: now - 300_000 });

    const html = await sessionsTab(h, owner.assertion);
    expect(html).toContain(
      '<p class="handle">laptop-aaa1 <span class="host">laptop</span></p>\n' +
        '<p class="state busy"><span class="dot"></span>busy</p>',
    );
    expect(html).toContain(
      '<p class="handle">laptop-bbb2 <span class="host">laptop</span></p>\n' +
        '<p class="state"><span class="dot"></span>idle 5m</p>',
    );
    expect(html.indexOf("laptop-aaa1")).toBeLessThan(html.indexOf("laptop-bbb2"));
  });

  it("shortens the prompt that opened the session and keeps the latest one whole", async () => {
    const h = await harness();
    const owner = await hosts(h);
    const now = h.now();
    await sync(owner.laptop, "cafe0001", {
      startedAt: now,
      lastActivityAt: now,
      focus: { first: "o".repeat(90), latest: "l".repeat(90) },
    });

    const html = await sessionsTab(h, owner.assertion);
    expect(html).toContain(`${"o".repeat(80)}…<span class="then"> → </span>${"l".repeat(90)}`);
  });

  it("says so when no host is running a session", async () => {
    const h = await harness();
    const owner = await signedIn(h);
    const html = await sessionsTab(h, owner.assertion);
    expect(html).toContain('<p class="empty">No session is running on any of your hosts.</p>');
    expect(html).not.toContain('class="feed"');
  });

  it("shows no session to a browser that carries no Access sign-in", async () => {
    const h = await harness();
    const owner = await hosts(h);
    await sync(owner.laptop, "9f8a1b2c", { startedAt: h.now(), lastActivityAt: h.now() });

    expect((await open(h, "/dashboard", null)).status).toBe(401);
    expect(await sessionsTab(h, null)).not.toContain("laptop-9f8a");
  });
});
