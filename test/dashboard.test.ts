import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { dayWindow, USAGE_CHART_DAYS } from "../src/model";
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

const navLink = (path: string, label: string, current: boolean): RegExp =>
  new RegExp(`<a href="${path}"${current ? ' aria-current="page"' : ""}><svg[^>]*>.*?</svg>${label}</a>`);

describe("the dashboard", () => {
  it("renders a tab of the shell and links to the others", async () => {
    const h = await harness();
    const owner = await signedIn(h);
    const response = await open(h, "/dashboard/stats", owner.assertion);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain(owner.email);
    expect(html).toMatch(navLink("/dashboard/stats", "Stats", true));
    for (const [path, label] of [
      ["/dashboard", "Sessions"],
      ["/dashboard/history", "History"],
      ["/dashboard/memory", "Memory"],
      ["/dashboard/insights", "Insights"],
    ] as const) {
      expect(html).toMatch(navLink(path, label, false));
    }
  });

  it("carries the live session summary onto a tab that does not list sessions", async () => {
    const h = await harness();
    const owner = await hosts(h);
    const now = h.now();
    await owner.laptop.sync("beef0001", { startedAt: now - 600_000, lastActivityAt: now });
    await owner.tower.sync("beef0002", { startedAt: now - 600_000, lastActivityAt: now - 600_000 });

    const response = await open(h, "/dashboard/memory", owner.assertion);
    expect(response.status).toBe(200);
    expect(plain(await response.text())).toContain("1 busy · 2 live");
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
    expect(plain(html)).toContain("repo:github.com/mvhenten/recall@feat/dashboard-sessions 12m 3 prompts");
    expect(html).toContain("tower-c4e2");
    expect(html).toContain(">idle 14m</p>");
    expect(html).toContain("draft the release notes");
    expect(plain(html)).toContain("global 3h 1 prompt");
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
    expect(html).not.toContain('class="sessions"');
  });
});

const DAY_MS = 86_400_000;

const historyTab = async (h: Harness, assertion: string, search = ""): Promise<string> => {
  const response = await open(h, `/dashboard/history${search}`, assertion);
  expect(response.status).toBe(200);
  return plain(await response.text());
};

const olderSessions = (html: string): string => {
  const href = /href="(\/dashboard\/history\?[^"]+)">Older sessions/.exec(html);
  if (!href?.[1]) throw new Error("the history shows no link to the older page");
  return href[1].replaceAll("&amp;", "&");
};

describe("the history tab", () => {
  it("groups the past sessions by day, newest day first, with its span, scope and prompts", async () => {
    const h = await harness();
    const owner = await hosts(h);
    const stranger = h.clientWithToken(await h.login(await h.invite(email("stranger")), "nomad"));
    const noon = Date.UTC(2026, 9, 30, 12, 0, 0);
    h.tick(noon - h.now());
    await owner.laptop.sync("9f8a1b2c", {
      host: "laptop",
      repo: "repo:github.com/mvhenten/recall",
      branch: "feat/dashboard-history",
      prompts: 31,
      focus: { first: "show the session history", latest: "group it by day" },
      startedAt: noon - 3_600_000,
      lastActivityAt: noon,
    });
    await owner.tower.sync("c4e21a99", {
      host: "tower",
      repo: "",
      branch: "",
      prompts: 1,
      focus: { first: "draft the release notes", latest: "" },
      startedAt: noon - DAY_MS - 2_700_000,
      lastActivityAt: noon - DAY_MS,
    });
    await stranger.sync("aa11bb22", { host: "nomad", startedAt: noon, lastActivityAt: noon });
    await owner.laptop.request("DELETE", "/v1/sessions/9f8a1b2c");
    await owner.tower.request("DELETE", "/v1/sessions/c4e21a99");

    const html = await historyTab(h, owner.assertion);
    expect(html).toContain("2026-10-30 · Fri 11:00–12:00 laptop-9f8a laptop");
    expect(html).toContain("show the session history → group it by day");
    expect(html).toContain("repo:github.com/mvhenten/recall@feat/dashboard-history 1h 00m 31 prompts");
    expect(html).toContain("2026-10-29 · Thu 11:15–12:00 tower-c4e2 tower");
    expect(html).toContain("global 45m 1 prompt");
    expect(html.indexOf("2026-10-30")).toBeLessThan(html.indexOf("2026-10-29"));
    expect(html).not.toContain("nomad");
  });

  it("marks a session that is still running and leaves the ended ones unmarked", async () => {
    const h = await harness();
    const owner = await hosts(h);
    const now = h.now();
    await owner.laptop.sync("1111aaaa", { startedAt: now - 600_000, lastActivityAt: now });
    await owner.laptop.sync("2222bbbb", { startedAt: now - 600_000, lastActivityAt: now });
    await owner.laptop.request("DELETE", "/v1/sessions/2222bbbb");

    const html = await historyTab(h, owner.assertion);
    expect(html).toContain("laptop-1111 laptop running");
    expect(html).not.toContain("laptop-2222 laptop running");
  });

  it("follows the cursor across a day boundary without repeating or skipping a session", async () => {
    const h = await harness();
    const owner = await hosts(h);
    const noon = Date.UTC(2026, 9, 30, 12, 0, 0);
    h.tick(noon - h.now());
    const ago: Array<[string, number]> = [
      ["aa110000", 0],
      ["bb220000", 60_000],
      ["cc330000", 120_000],
      ["dd440000", DAY_MS],
      ["ee550000", DAY_MS + 60_000],
    ];
    for (const [sessionId, since] of ago) {
      await owner.laptop.sync(sessionId, { startedAt: noon - since - 600_000, lastActivityAt: noon - since });
    }

    const response = await open(h, "/dashboard/history?limit=2", owner.assertion);
    const markup = await response.text();
    const first = plain(markup);
    expect(first).toContain("2026-10-30 · Fri");
    expect(first).toContain("laptop-aa11");
    expect(first).toContain("laptop-bb22");
    expect(first).not.toContain("laptop-cc33");
    expect(first).not.toContain("2026-10-29");

    const second = await historyTab(h, owner.assertion, olderSessions(markup).replace("/dashboard/history", ""));
    expect(second).toContain("2026-10-30 · Fri");
    expect(second).toContain("laptop-cc33");
    expect(second).toContain("2026-10-29 · Thu");
    expect(second).toContain("laptop-dd44");
    expect(second).not.toContain("laptop-aa11");
    expect(second).not.toContain("laptop-ee55");
  });

  it("narrows the days to one host and to one repo, offering only the values it holds", async () => {
    const h = await harness();
    const owner = await hosts(h);
    const now = h.now();
    await owner.laptop.sync("abc10000", {
      host: "laptop",
      repo: "repo:github.com/acme/app",
      focus: { first: "the laptop session", latest: "" },
      startedAt: now - 600_000,
      lastActivityAt: now,
    });
    await owner.tower.sync("def20000", {
      host: "tower",
      repo: "repo:github.com/acme/infra",
      focus: { first: "the tower session", latest: "" },
      startedAt: now - 600_000,
      lastActivityAt: now - 60_000,
    });

    const all = await historyTab(h, owner.assertion);
    expect(all).toContain("All hosts laptop tower");
    expect(all).toContain("All repos repo:github.com/acme/app repo:github.com/acme/infra");

    const byHost = await historyTab(h, owner.assertion, "?host=tower");
    expect(byHost).toContain("the tower session");
    expect(byHost).not.toContain("the laptop session");

    const byRepo = await historyTab(h, owner.assertion, "?repo=repo:github.com/acme/app");
    expect(byRepo).toContain("the laptop session");
    expect(byRepo).not.toContain("the tower session");

    const nothing = await historyTab(h, owner.assertion, "?host=nowhere");
    expect(nothing).toContain("No session matches this filter.");
    expect(nothing).not.toContain("the laptop session");
  });

  it("says so when the history is empty, and stays behind Access", async () => {
    const h = await harness();
    const owner = await signedIn(h);
    expect(await historyTab(h, owner.assertion)).toContain("No session is in your history yet.");
    expect((await open(h, "/dashboard/history", null)).status).toBe(401);
    expect((await open(h, "/dashboard/history", await h.assertionFor(email("stranger")))).status).toBe(403);
  });
});

interface Owner {
  email: string;
  assertion: string;
  client: Client;
}

const withMemories = async (h: Harness, label = "owner"): Promise<Owner> => {
  const address = await h.invite(email(label));
  return {
    email: address,
    assertion: await h.assertionFor(address),
    client: h.clientWithToken(await h.login(address, "laptop")),
  };
};

const plain = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

const memoryTab = async (h: Harness, owner: Owner, search = ""): Promise<string> => {
  const response = await open(h, `/dashboard/memory${search}`, owner.assertion);
  expect(response.status).toBe(200);
  return plain(await response.text());
};

const older = (html: string): string => {
  const href = /href="(\/dashboard\/memory\?[^"]+)">Older memories/.exec(html);
  if (!href?.[1]) throw new Error("the listing shows no link to the older page");
  return href[1].replaceAll("&amp;", "&");
};

describe("the memory tab", () => {
  it("lists the signed-in user's memories newest created first and no stranger's", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    const stranger = await withMemories(h, "stranger");
    await owner.client.save("oldest-note", { description: "the first thing learned" });
    h.tick(1_000);
    await owner.client.save("newest-note", { description: "the latest thing learned", type: "user" });
    await stranger.client.save("stranger-note", { description: "none of the owner's business" });

    const html = await memoryTab(h, owner);
    expect(html).toContain("newest-note");
    expect(html).toContain("the latest thing learned");
    expect(html).toContain("oldest-note");
    expect(html.indexOf("newest-note")).toBeLessThan(html.indexOf("oldest-note"));
    expect(html).not.toContain("stranger-note");
    expect(html).not.toContain("none of the owner's business");
  });

  it("counts the memories, the recalled, the never recalled and the fresh ones per type", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    await owner.client.save("read-often", { type: "user" });
    await owner.client.save("read-never", { type: "project" });
    await owner.client.save("read-never-either", { type: "project" });
    expect((await owner.client.request("GET", "/v1/memories/read-often?recall=true")).status).toBe(200);

    const html = await memoryTab(h, owner);
    expect(html).toContain("3 memories");
    expect(html).toContain("1 recalled");
    expect(html).toContain("2 never recalled");
    expect(html).toContain("3 new in 30 days");
    expect(html).toContain("project 2");
    expect(html).toContain("user 1");
  });

  it("narrows the listing by tag and by type, and refuses a type it does not know", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    await owner.client.save("repo-note", { type: "project", tags: ["repo:github.com/acme/app"] });
    await owner.client.save("global-note", { type: "reference", tags: ["global"] });

    const byTag = await memoryTab(h, owner, "?tag=global");
    expect(byTag).toContain("global-note");
    expect(byTag).not.toContain("repo-note");

    const byType = await memoryTab(h, owner, "?type=project");
    expect(byType).toContain("repo-note");
    expect(byType).not.toContain("global-note");

    const refused = await open(h, "/dashboard/memory?type=notatype", owner.assertion);
    expect(refused.status).toBe(400);
    expect(plain(await refused.text())).toContain("type must be one of user, feedback, project, reference");
  });

  it("takes the empty form as no filter at all", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    await owner.client.save("kept-note", {});
    expect(await memoryTab(h, owner, "?q=&tag=&type=")).toContain("kept-note");
  });

  it("follows the cursor to the older page, keeping the tag and the page size", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    for (const name of ["first-note", "second-note", "third-note", "fourth-note", "fifth-note"]) {
      await owner.client.save(name, { tags: ["global"] });
      h.tick(1_000);
    }
    await owner.client.save("other-note", { tags: ["repo:github.com/acme/app"] });

    const response = await open(h, "/dashboard/memory?tag=global&limit=2", owner.assertion);
    const markup = await response.text();
    const first = plain(markup);
    expect(first).toContain("fifth-note");
    expect(first).toContain("fourth-note");
    expect(first).not.toContain("third-note");

    const page = await open(h, older(markup), owner.assertion);
    expect(page.status).toBe(200);
    const second = plain(await page.text());
    expect(second).toContain("third-note");
    expect(second).toContain("second-note");
    expect(second).not.toContain("first-note");
    expect(second).not.toContain("other-note");
  });

  it("narrows to the memories a search matches, with a score, and says so when none do", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    await owner.client.save("coffee-order", { body: "he takes his espresso ristretto" });
    await owner.client.save("deploy-steps", { body: "run the migration before the worker" });

    const found = await memoryTab(h, owner, "?q=espresso");
    expect(found).toContain("coffee-order");
    expect(found).not.toContain("deploy-steps");
    expect(found).toMatch(/score 0\.\d{3}/);

    const nothing = await memoryTab(h, owner, "?q=kombucha");
    expect(nothing).toContain("No memory matches this search.");
    expect(nothing).not.toContain("coffee-order");
  });

  it("narrows a search by type however deep the match ranks", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    for (let note = 0; note < 21; note++) {
      await owner.client.save(`deploy-note-${note}`, { type: "project", body: "deploy the pipeline" });
    }
    await owner.client.save("deploy-archive", { type: "reference", body: "deploy the pipeline" });

    const html = await memoryTab(h, owner, "?q=deploy&type=reference");
    expect(html).toContain("deploy-archive");
    expect(html).not.toContain("deploy-note-");
  });

  it("says so when nothing is saved yet", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    expect(await memoryTab(h, owner)).toContain("No memory is saved yet.");
  });

  it("stays behind Access, for the listing and for one memory", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    await owner.client.save("private-note", {});
    const stranger = email("stranger");

    for (const path of ["/dashboard/memory", "/dashboard/memory/private-note"]) {
      expect((await open(h, path, null)).status).toBe(401);
      expect((await open(h, path, await h.assertionFor(stranger))).status).toBe(403);
    }
  });
});

describe("one memory's page", () => {
  it("renders the body and never lets its markdown become markup", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    await owner.client.save("risky-note", {
      description: "holds markup a browser must not run",
      type: "reference",
      tags: ["global"],
      body: "# heading\n\n<script>alert('pwned')</script>\n\n- a & b < c",
    });

    const response = await open(h, "/dashboard/memory/risky-note", owner.assertion);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    const text = plain(html);
    expect(text).toContain("risky-note");
    expect(text).toContain("holds markup a browser must not run");
    expect(text).toContain("# heading");
    expect(text).toContain("reference");
    expect(text).toContain("global");
  });

  it("leaves the recall count and the last recall alone", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    await owner.client.save("quiet-note", {});
    expect((await owner.client.request("GET", "/v1/memories/quiet-note?recall=true")).status).toBe(200);
    const before = await owner.client.get("quiet-note");
    h.tick(60_000);

    expect((await open(h, "/dashboard/memory/quiet-note", owner.assertion)).status).toBe(200);
    expect(await memoryTab(h, owner, "?q=quiet")).toContain("quiet-note");
    const after = await owner.client.get("quiet-note");
    expect(after.recallCount).toBe(before.recallCount);
    expect(after.lastRecalledAt).toBe(before.lastRecalledAt);
  });

  it("has no page for a memory this user does not have", async () => {
    const h = await harness();
    const owner = await withMemories(h);
    const stranger = await withMemories(h, "stranger");
    await stranger.client.save("stranger-note", {});

    for (const path of ["/dashboard/memory/stranger-note", "/dashboard/memory/never-saved", "/dashboard/memory/Nope"]) {
      const response = await open(h, path, owner.assertion);
      expect(response.status).toBe(404);
      expect(plain(await response.text())).toContain("This recall holds no memory at this address.");
    }
  });
});

const NOON = Date.UTC(2026, 10, 2, 12, 0, 0);
const OPUS = "claude-opus-4-5-20251101";

interface Reporter {
  email: string;
  userId: string;
  assertion: string;
  client: Client;
}

const reporting = async (h: Harness, label = "owner"): Promise<Reporter> => {
  const userId = `${label}-${crypto.randomUUID()}`;
  const address = await h.invite(email(label), userId);
  return {
    email: address,
    userId,
    assertion: await h.assertionFor(address),
    client: h.clientWithToken(await h.login(address, "laptop")),
  };
};

const NOTHING = { prompts: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

const spender = (who: Reporter): ((fields: Record<string, unknown>) => Promise<void>) => {
  let seq = 0;
  return async (fields: Record<string, unknown>): Promise<void> => {
    seq += 1;
    const response = await who.client.usage("usage001", {
      provider: "claude",
      model: OPUS,
      ...NOTHING,
      ...fields,
      seq,
    });
    expect(response.status).toBe(204);
  };
};

const statsTab = async (h: Harness, who: Reporter): Promise<string> => {
  const response = await open(h, "/dashboard/stats", who.assertion);
  expect(response.status).toBe(200);
  return plain(await response.text());
};

const insightsHtml = async (h: Harness, who: Reporter): Promise<string> => {
  const response = await open(h, "/dashboard/insights", who.assertion);
  expect(response.status).toBe(200);
  return response.text();
};

const insightsTab = async (h: Harness, who: Reporter): Promise<string> => plain(await insightsHtml(h, who));

// The track a horizontal bar is drawn on, in the chart's own units. A rate is a share of the whole
// track, so reading one bar's end back is the only way to tell that scale from a max-relative one.
const TRACK = 186;

const barShare = (html: string, label: string): number => {
  const row = new RegExp(`>${label}</text><path d="M160,\\d+ L([\\d.]+),`).exec(html);
  if (!row?.[1]) throw new Error(`no bar is drawn for ${label}`);
  return (Number(row[1]) + 3 - 160) / TRACK;
};

const eventCount = async (userId: string): Promise<number> => {
  const row = await env.DB.prepare("SELECT COUNT(*) AS events FROM usage_events WHERE user_id = ?")
    .bind(userId)
    .first<{ events: number }>();
  return row?.events ?? 0;
};

describe("the stats tab", () => {
  it("prices every model from its own rates and names the tokens it cannot price", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    const spend = spender(owner);
    await spend({
      at: NOON,
      prompts: 1,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    await spend({ at: NOON, model: "mystery-1", inputTokens: 2_000_000 });
    await spend({ at: NOON, model: "mystery-1", account: "lab", inputTokens: 1_000_000 });

    const html = await statsTab(h, owner);
    expect(html).toContain("Cost today $36.75");
    expect(html).toContain("3.0M tokens carry no price.");
    expect(html).toContain("Opus 4.5 4.0M $37");
    expect(html).toContain("mystery-1 3.0M unpriced");
    expect(html).toContain("work 6.0M ≈ $36.75");
    expect(html).toContain("lab 1.0M unpriced");
  });

  it("reads the cache hit and the output-to-input ratio out of the seeded counters", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    await spender(owner)({
      at: NOON,
      prompts: 10,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 9_000_000,
    });

    const html = await statsTab(h, owner);
    expect(html).toContain("Cache hit · 7d 90%");
    expect(html).toContain("Output per input 1 : 2");
    expect(html).toContain("Cost per prompt $2.20");
    expect(html).toContain("Cache hit 90.0%");
  });

  it("keeps today, the last seven days and the last thirty apart", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    const spend = spender(owner);
    await spend({ at: NOON, inputTokens: 1_000_000 });
    await spend({ at: NOON - 3 * DAY_MS, inputTokens: 2_000_000 });
    await spend({ at: NOON - 20 * DAY_MS, inputTokens: 4_000_000 });
    await spend({ at: NOON - 40 * DAY_MS, inputTokens: 8_000_000 });

    const html = await statsTab(h, owner);
    expect(html).toContain("Cost today $5.00");
    expect(html).toContain("Cost · 7 days $15.00");
    expect(html).toContain("$35 30 days");
    expect(html).not.toContain("$75");
  });

  it("still counts a day whose raw events the sweep has dropped", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - 20 * DAY_MS - h.now());
    const spend = spender(owner);
    await spend({ at: h.now(), inputTokens: 2_000_000 });
    h.tick(20 * DAY_MS);
    await spend({ at: h.now(), inputTokens: 1_000_000 });

    expect(await eventCount(owner.userId)).toBe(1);
    const html = await statsTab(h, owner);
    expect(html).toContain("Cost today $5.00");
    expect(html).toContain("$15 30 days");
  });

  it("splits the month by account, by host and by repo", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    const spend = spender(owner);
    await spend({
      at: NOON,
      account: "work",
      host: "laptop",
      repo: "repo:github.com/acme/app",
      inputTokens: 1_000_000,
    });
    await spend({
      at: NOON,
      account: "personal",
      host: "tower",
      repo: "repo:github.com/acme/infra",
      inputTokens: 2_000_000,
    });

    const html = await statsTab(h, owner);
    expect(html).toContain("personal 2.0M $10.00");
    expect(html).toContain("work 1.0M $5.00");
    expect(html).toContain("tower 2.0M $10.00");
    expect(html).toContain("repo:github.com/acme/infra 2.0M $10.00");
  });

  it("says so when nothing is recorded, and never counts a stranger's usage", async () => {
    const h = await harness();
    const owner = await reporting(h);
    const stranger = await reporting(h, "stranger");
    h.tick(NOON - h.now());
    await spender(stranger)({ at: NOON, inputTokens: 1_000_000 });

    const html = await statsTab(h, owner);
    expect(html).toContain("No usage is recorded yet.");
    expect(html).not.toContain("$5.00");
  });

  it("stays behind Access", async () => {
    const h = await harness();
    expect((await open(h, "/dashboard/stats", null)).status).toBe(401);
    expect((await open(h, "/dashboard/stats", await h.assertionFor(email("stranger")))).status).toBe(403);
  });
});

describe("the insights tab", () => {
  const recall = async (who: Reporter, name: string): Promise<void> => {
    expect((await who.client.request("GET", `/v1/memories/${name}?recall=true`)).status).toBe(200);
  };

  it("names the working set and its share of every recall", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    await owner.client.save("pr-review-threads", {});
    await owner.client.save("worktree-setup", {});
    for (const _ of [1, 2, 3]) await recall(owner, "pr-review-threads");
    await recall(owner, "worktree-setup");

    const html = await insightsTab(h, owner);
    expect(html).toContain("pr-review-threads 3 recalls");
    expect(html).toContain("worktree-setup 1");
    expect(html).toContain("These 2 carry 100% of every recall in the window.");
  });

  it("lists what is going stale and what was never recalled", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - 61 * DAY_MS - h.now());
    await owner.client.save("podcast-rss-layout", {});
    await recall(owner, "podcast-rss-layout");
    await owner.client.save("jira-sprint-fields", {});
    h.tick(61 * DAY_MS);
    await owner.client.save("fresh-note", {});

    const html = await insightsTab(h, owner);
    expect(html).toContain("podcast-rss-layout 61d ago");
    expect(html).toContain("jira-sprint-fields never · saved 61d");
    expect(html).toContain("2 of 3 memories are at risk.");
    expect(html).not.toContain("fresh-note");
  });

  it("clips session time to the window and counts it as session time", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    const { since } = dayWindow(NOON, USAGE_CHART_DAYS);
    await owner.client.sync("long0001", {
      repo: "repo:github.com/acme/app",
      startedAt: since - DAY_MS,
      lastActivityAt: since + 2 * 3_600_000,
    });
    await owner.client.sync("short001", {
      repo: "repo:github.com/acme/infra",
      startedAt: NOON - 3 * 3_600_000,
      lastActivityAt: NOON,
    });

    const html = await insightsTab(h, owner);
    expect(html).toContain("acme/infra 3h");
    expect(html).toContain("acme/app 2h");
    expect(html).toContain("acme/infra took 3h of the fortnight's 5h of session time.");
  });

  it("finds the busiest hour of the week", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    for (const [id, offset] of [
      ["busy0001", 3 * 3_600_000],
      ["busy0002", 3 * 3_600_000 - 600_000],
      ["busy0003", 3_600_000],
    ] as const) {
      await owner.client.sync(id, { repo: "", startedAt: NOON - offset, lastActivityAt: NOON });
    }

    const html = await insightsTab(h, owner);
    expect(html).toContain("The busiest hour is 09:00 on Monday, with 2 sessions started.");
  });

  it("reports what the cache saved, ranking a day that read nothing out of it", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    const spend = spender(owner);
    await spend({ at: NOON, prompts: 1, inputTokens: 2_000_000, cacheReadTokens: 10_000_000 });
    await spend({ at: NOON - DAY_MS, prompts: 1, inputTokens: 1_000_000, cacheReadTokens: 9_000_000 });
    await spend({ at: NOON - 2 * DAY_MS, prompts: 1, inputTokens: 1_000_000 });

    const html = await insightsTab(h, owner);
    expect(html).toContain("Cache reads 19M tokens");
    expect(html).toContain("Saved vs fresh input ≈ $85.50");
    expect(html).toContain("Best day 2026-11-01 · 90.0%");
    expect(html).toContain("Worst day 2026-10-31 · 0.0%");
    expect(html).toContain("83% of the fortnight's input came back out of the cache");
  });

  it("names no best or worst day until there are two to tell apart", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    await spender(owner)({ at: NOON, prompts: 1, inputTokens: 1_000_000, cacheReadTokens: 9_000_000 });

    const html = await insightsTab(h, owner);
    expect(html).toContain("Cache reads 9.0M tokens");
    expect(html).not.toContain("Best day");
    expect(html).not.toContain("Worst day");
  });

  it("renders an empty state per module when there is nothing to say", async () => {
    const h = await harness();
    const owner = await reporting(h);
    const stranger = await reporting(h, "stranger");
    h.tick(NOON - h.now());
    await spender(stranger)({ at: NOON, inputTokens: 1_000_000, cacheReadTokens: 1_000_000 });
    await stranger.client.save("stranger-note", {});

    const html = await insightsTab(h, owner);
    expect(html).toContain("No memory has been recalled lately.");
    expect(html).toContain("Nothing is going stale.");
    expect(html).toContain("No cache read is recorded yet.");
    expect(html).toContain("No session has been recorded yet.");
    expect(html).toContain("No session ran in this window.");
    expect(html).toContain("No month of usage is on record yet.");
    expect(html).toContain("No month has any input to grade.");
    expect(html).toContain("No session has ever synced.");
    expect(html).not.toContain("stranger-note");
  });

  it("stays behind Access", async () => {
    const h = await harness();
    expect((await open(h, "/dashboard/insights", null)).status).toBe(401);
    expect((await open(h, "/dashboard/insights", await h.assertionFor(email("stranger")))).status).toBe(403);
  });
});

const AUGUST = Date.UTC(2026, 7, 15, 12, 0, 0);
const SEPTEMBER = Date.UTC(2026, 8, 15, 12, 0, 0);
const OCTOBER_LAST = Date.UTC(2026, 9, 31, 12, 0, 0);
const NOVEMBER_FIRST = Date.UTC(2026, 10, 1, 12, 0, 0);

describe("the long horizon on the insights tab", () => {
  it("buckets a delta by the month of the day it was counted under, and keeps a quiet month on the axis", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    const spend = spender(owner);
    await spend({ at: AUGUST, inputTokens: 4_000_000 });
    await spend({ at: OCTOBER_LAST, inputTokens: 1_000_000 });
    await spend({ at: NOVEMBER_FIRST, inputTokens: 2_000_000 });

    const html = await insightsTab(h, owner);
    expect(html).toContain("$35.00 and 7.0M tokens over 4 months, peaking in 2026-08 at $20.00.");
    expect(html).toContain("Aug 26");
  });

  it("marks a month total that mixes a priced model with an unpriced one as the floor it is", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    const spend = spender(owner);
    await spend({ at: OCTOBER_LAST, model: "mystery-1", inputTokens: 2_000_000 });
    await spend({ at: NOON, inputTokens: 1_000_000 });

    const html = await insightsTab(h, owner);
    expect(html).toContain("≈ $5.00 and 3.0M tokens over 2 months, peaking in 2026-11 at $5.00.");
  });

  it("prices no month at all when no model on record carries a price", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    await spender(owner)({ at: NOON, model: "mystery-1", inputTokens: 1_000_000 });

    const html = await insightsTab(h, owner);
    expect(html).toContain("No model on record carries a price.");
    expect(html).toContain("mystery-1 has no entry in the price table");
    expect(html).not.toContain("peaking in");
  });

  it("ranks every repo by all the session time on record, clipping a span that runs past now", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    await owner.client.sync("old00001", {
      repo: "repo:github.com/acme/old",
      startedAt: AUGUST,
      lastActivityAt: AUGUST + 7 * 3_600_000,
    });
    await owner.client.sync("edge0001", {
      repo: "repo:github.com/acme/app",
      startedAt: Date.UTC(2026, 9, 31, 22, 0, 0),
      lastActivityAt: Date.UTC(2026, 10, 1, 2, 0, 0),
    });
    await owner.client.sync("now00001", {
      repo: "repo:github.com/acme/app",
      startedAt: NOON - 2 * 3_600_000,
      lastActivityAt: NOON,
    });
    await owner.client.sync("ahead001", {
      repo: "repo:github.com/acme/ahead",
      startedAt: NOON - 3_600_000,
      lastActivityAt: NOON + 5 * 3_600_000,
    });

    const html = await insightsTab(h, owner);
    expect(html).toContain("acme/old took 7h of the 14h these 3 repos hold, over 4 sessions.");
    expect(html).toContain("acme/ahead 1h");
    expect(html).not.toContain("acme/ahead 6h");
  });

  it("grades the cache hit rate by month, leaving out a month with no input to grade", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    const spend = spender(owner);
    await spend({ at: SEPTEMBER, inputTokens: 1_000_000, cacheReadTokens: 1_000_000 });
    await spend({ at: OCTOBER_LAST, outputTokens: 1_000_000 });
    await spend({ at: NOON, inputTokens: 1_000_000, cacheReadTokens: 9_000_000 });

    const raw = await insightsHtml(h, owner);
    const html = plain(raw);
    expect(html).toContain("2026-09 50.0%");
    expect(html).toContain("2026-11 90.0%");
    expect(html).toContain("The hit rate went from 50.0% in 2026-09 to 90.0% in 2026-11.");
    expect(html).not.toContain("2026-10 0.0%");
    expect(barShare(raw, "2026-09")).toBeCloseTo(0.5, 2);
    expect(barShare(raw, "2026-11")).toBeCloseTo(0.9, 2);
  });

  it("names the one month on record rather than a drift between two", async () => {
    const h = await harness();
    const owner = await reporting(h);
    h.tick(NOON - h.now());
    await spender(owner)({ at: NOON, inputTokens: 1_000_000, cacheReadTokens: 3_000_000 });

    const html = await insightsTab(h, owner);
    expect(html).toContain("2026-11 is the only month with input to grade, at 75.0%.");
  });
});
