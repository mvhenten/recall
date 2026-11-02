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
    expect(html).toContain('<a href="/dashboard/stats" aria-current="page">');
    for (const [path, label] of [
      ["/dashboard", "Sessions"],
      ["/dashboard/history", "History"],
      ["/dashboard/memory", "Memory"],
      ["/dashboard/insights", "Insights"],
    ]) {
      expect(html).toContain(`<a href="${path}">`);
      expect(plain(html)).toContain(label);
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
    expect(html).toContain(">repo:github.com/mvhenten/recall@feat/dashboard-sessions<");
    expect(html).toContain(">12m<");
    expect(html).toContain('3<span class="unit"> prompts</span>');
    expect(html).toContain("tower-c4e2");
    expect(html).toContain(">idle 14m</p>");
    expect(html).toContain("draft the release notes");
    expect(html).toContain(">global<");
    expect(html).toContain(">3h<");
    expect(html).toContain('1<span class="unit"> prompt</span>');
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
