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
    await owner.laptop.sync("9f8a1b2c", {
      host: "laptop",
      repo: "repo:github.com/mvhenten/recall",
      branch: "feat/dashboard-sessions",
      prompts: 3,
      focus: { first: "list the sessions", latest: "why is the worker test red" },
      startedAt: now - 720_000,
      lastActivityAt: now - 60_000,
    });
    await owner.tower.sync("c4e21a99", {
      host: "tower",
      repo: "",
      branch: "",
      prompts: 1,
      focus: { first: "draft the release notes", latest: "" },
      startedAt: now - 10_800_000,
      lastActivityAt: now - 840_000,
    });
    await stranger.sync("aa11bb22", { host: "nomad", startedAt: now, lastActivityAt: now });

    const html = await sessionsTab(h, owner.assertion);
    expect(html).toContain("laptop-9f8a");
    expect(html).toContain(">busy</p>");
    expect(html).toContain("list the sessions");
    expect(html).toContain("why is the worker test red");
    expect(html).toContain("repo:github.com/mvhenten/recall@feat/dashboard-sessions · 12m · 3 prompts");
    expect(html).toContain("tower-c4e2");
    expect(html).toContain(">idle 14m</p>");
    expect(html).toContain("draft the release notes");
    expect(html).toContain("global · 3h · 1 prompt");
    expect(html.indexOf("laptop-9f8a")).toBeLessThan(html.indexOf("tower-c4e2"));
    expect(html).not.toContain("nomad");
  });

  it("reads busy for five minutes after the last prompt, idle from then on", async () => {
    const h = await harness();
    const owner = await hosts(h);
    const now = h.now();
    await owner.laptop.sync("aaa10000", { startedAt: now - 600_000, lastActivityAt: now - 299_999 });
    await owner.laptop.sync("bbb20000", { startedAt: now - 600_000, lastActivityAt: now - 300_000 });

    const html = await sessionsTab(h, owner.assertion);
    expect(html).toContain(">busy</p>");
    expect(html).toContain(">idle 5m</p>");
    expect(html.indexOf("laptop-aaa1")).toBeLessThan(html.indexOf("laptop-bbb2"));
  });

  it("shortens the prompt that opened the session and keeps the latest one whole", async () => {
    const h = await harness();
    const owner = await hosts(h);
    const now = h.now();
    await owner.laptop.sync("cafe0001", {
      startedAt: now,
      lastActivityAt: now,
      focus: { first: "o".repeat(90), latest: "l".repeat(90) },
    });

    const html = await sessionsTab(h, owner.assertion);
    expect(html).toContain(`${"o".repeat(80)}…`);
    expect(html).toContain("l".repeat(90));
    expect(html).not.toContain("o".repeat(81));
  });

  it("says so when no host is running a session", async () => {
    const h = await harness();
    const owner = await signedIn(h);
    const html = await sessionsTab(h, owner.assertion);
    expect(html).toContain("No session is running on any of your hosts.");
    expect(html).not.toContain('class="feed"');
  });
});
