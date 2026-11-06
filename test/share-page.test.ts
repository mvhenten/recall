import { describe, expect, it } from "vitest";
import { DEVICE_CODE_LIMITS } from "../src/device";
import { MAX_EMAIL_SHARES, SHARE_WINDOW_MS, type ShareView } from "../src/shares";
import { ARTIFACT_AUDIENCE, ARTIFACT_HOSTNAME, type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

const ORIGIN = "https://recall.test";

const DOC = "# Quarterly plan\n\nA paragraph with [a link](./appendix.md) and an image: ![cover](/cover.png)\n";

interface Owner {
  h: Harness;
  email: string;
  alice: Client;
  dashboard: string;
  host: string;
}

const owner = async (artifacts: "on" | "off" = "on"): Promise<Owner> => {
  const h = await harness("up", DEVICE_CODE_LIMITS, artifacts);
  const email = `alice-${crypto.randomUUID()}@example.com`;
  await h.invite(email);
  return {
    h,
    email,
    alice: h.clientWithToken(await h.login(email)),
    dashboard: await h.assertionFor(email),
    host: await h.assertionFor(email, ARTIFACT_AUDIENCE),
  };
};

const publishDocument = (alice: Client, name: string, read = "private"): Promise<Response> =>
  alice.publishArtifact(name, {
    type: "document",
    title: "Quarterly plan",
    description: "How the desk closed the quarter.",
    read,
    files: [{ path: "notes.md", body: DOC }],
  });

const audio = (alice: Client, name: string): Promise<Response> =>
  alice.publishArtifact(name, {
    type: "audio",
    title: "Panel episode 12",
    files: [
      { path: "opening-theme.mp3", body: "one" },
      { path: "the-first-question.mp3", body: "two" },
    ],
  });

const site = (alice: Client, name: string): Promise<Response> =>
  alice.publishArtifact(name, { files: [{ path: "index.html", body: "<p>release notes</p>" }] });

interface Drawn {
  status: number;
  html: string;
  csrf: string;
  cookie: string;
  headers: Headers;
}

const sharePage = async (o: Owner, name: string, query = ""): Promise<Drawn> => {
  const response = await o.h.send(`/dashboard/artifacts/${encodeURIComponent(name)}/shares${query}`, {
    headers: { "cf-access-jwt-assertion": o.dashboard },
  });
  const html = await response.text();
  return {
    status: response.status,
    html,
    csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "",
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    headers: response.headers,
  };
};

const post = async (o: Owner, name: string, fields: Record<string, string>, origin = ORIGIN): Promise<Drawn> => {
  const page = await sharePage(o, name);
  const response = await o.h.send(`/dashboard/artifacts/${encodeURIComponent(name)}/shares`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": o.dashboard,
      origin,
      cookie: page.cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ ...fields, csrf: page.csrf }),
  });
  const html = await response.text();
  return {
    status: response.status,
    html,
    csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "",
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    headers: response.headers,
  };
};

interface Minted {
  share: ShareView;
  address: string;
}

const mint = async (alice: Client, name: string, address?: string): Promise<Minted> => {
  const body = address === undefined ? { mode: "link" } : { mode: "email", address };
  const response = await alice.request("POST", `/v1/artifacts/${encodeURIComponent(name)}/shares`, body);
  if (response.status !== 200) throw new Error(`share: ${response.status} ${await response.text()}`);
  return response.json();
};

const basePath = (address: string): string => new URL(address).pathname;

const read = (o: Owner, path: string, assertion: string | null = null): Promise<Response> =>
  o.h.sendToSharePrefix(path, assertion);

describe("the share page", () => {
  it("says an artifact is shared with nobody and keeps both controls", async () => {
    const o = await owner();
    await publishDocument(o.alice, "release-notes");

    const page = await sharePage(o, "release-notes");
    expect(page.status).toBe(200);
    expect(page.html).toContain("release-notes is shared with nobody.");
    expect(page.html).toContain("Share by email");
    expect(page.html).toContain("Create a link");
    expect(page.html).not.toContain("Extend by 30 days");
    expect(page.html).toContain('<a href="/dashboard/artifacts" aria-current="page">');
    expect(page.html).not.toContain("<script");
  });

  it("says a share works whatever the read permission says, and only where it is private", async () => {
    const o = await owner();
    await publishDocument(o.alice, "closed-plan", "private");
    await publishDocument(o.alice, "open-plan", "account");

    const line = "A share works whatever the read permission says.";
    expect((await sharePage(o, "closed-plan")).html).toContain(line);
    expect((await sharePage(o, "open-plan")).html).not.toContain(line);
  });

  it("prints a link share's whole address once, and never again", async () => {
    const o = await owner();
    await publishDocument(o.alice, "release-notes");

    const made = await post(o, "release-notes", { do: "link" });
    expect(made.status).toBe(200);
    const address = `https://${ARTIFACT_HOSTNAME}/link/`;
    expect(made.html).toContain("This is the only time this address is shown.");
    expect(made.html).toContain(address);
    expect(made.html).not.toContain("…");
    const token = /\/link\/([A-Za-z0-9_-]+)</.exec(made.html)?.[1] ?? "";
    expect(token.length).toBeGreaterThan(32);

    const again = await sharePage(o, "release-notes");
    expect(again.html).toContain("Anyone with the link");
    expect(again.html).not.toContain(token);
    expect(again.html).not.toContain("/link/");
    expect(again.html).toContain("Replace the link");
    expect(again.html).toContain("Extend by 30 days");
  });

  it("names each share's recipient, mode, dates and use, lower-cased and never opened", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");
    await mint(o.alice, "quarterly-plan", "Reader@Example.COM");

    const page = await sharePage(o, "quarterly-plan");
    expect(page.html).toContain("reader@example.com");
    expect(page.html).not.toContain("Reader@Example.COM");
    expect(page.html).toContain("never opened");
    expect(page.html).toContain("document · 1 share");
    expect(page.html).toContain("Revoke the share with reader@example.com");
  });

  it("names the time left once an expiry falls inside fourteen days", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");
    await mint(o.alice, "quarterly-plan", "reader@example.com");

    expect((await sharePage(o, "quarterly-plan")).html).not.toContain("days left");
    o.h.tick(SHARE_WINDOW_MS - 13 * 86_400_000);
    expect((await sharePage(o, "quarterly-plan")).html).toContain("13 days left");
  });

  it("asks before it replaces a link, with every create control gone and the row inert", async () => {
    const o = await owner();
    await publishDocument(o.alice, "release-notes");
    await mint(o.alice, "release-notes");

    const asked = await sharePage(o, "release-notes", "?relink=1");
    expect(asked.status).toBe(200);
    expect(asked.html).toContain("Replace the link share?");
    expect(asked.html).toContain("replacing the link");
    expect(asked.html).toContain("Keep it");
    expect(asked.html).not.toContain("Share by email");
    expect(asked.html).not.toContain("Extend by 30 days");
    expect(asked.html).toContain('aria-disabled="true"');
    expect(asked.html).toContain('aria-describedby="askwhy"');
    expect(asked.html).not.toContain("<script");
  });

  it("keeps a refused address in the form and names what an address must hold", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");

    const refused = await post(o, "quarterly-plan", { do: "email", address: "reader@example" });
    expect(refused.status).toBe(200);
    expect(refused.html).toContain('value="reader@example"');
    expect(refused.html).toContain("an address holds a name, an @ and a domain with a dot");
    expect(refused.html).toContain('class="flash bad"');
    expect(refused.html).not.toContain("invalid");
    expect(refused.html).toContain('aria-describedby="sflash"');
  });

  it("draws the limit as a card with an inert submit, and keeps the link control live", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");
    for (let index = 0; index < MAX_EMAIL_SHARES; index += 1) {
      await mint(o.alice, "quarterly-plan", `reader-${index}@example.com`);
    }

    const page = await sharePage(o, "quarterly-plan");
    expect(page.html).toContain(`This artifact holds ${MAX_EMAIL_SHARES} email shares, the most one takes.`);
    expect(page.html).toContain("The limit is per artifact");
    expect(page.html).toContain('<button class="sgo" type="button" aria-disabled="true" aria-describedby="sfull">');
    expect(page.html).toContain('<button class="sctl" type="submit" name="do" value="link">');
  });

  it("asks one question at a time and marks the list kept or going", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");
    const first = await mint(o.alice, "quarterly-plan", "jo@example.org");
    await mint(o.alice, "quarterly-plan", "reader@example.com");

    const one = await sharePage(o, "quarterly-plan", `?revoke=${first.share.shareId}`);
    expect(one.html).toContain("Revoke the share with jo@example.org?");
    expect(one.html).toContain("the one in question");
    expect(one.html).toContain(">going<");
    expect(one.html).toContain(">kept<");
    expect(one.html).not.toContain("Share by email");

    const all = await sharePage(o, "quarterly-plan", "?revoke=all");
    expect(all.html).toContain("Revoke all 2 shares on quarterly-plan?");
    expect(all.html).not.toContain(">kept<");
  });

  it("asks nothing when a revoke names no live share, and lists what remains", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");
    await mint(o.alice, "quarterly-plan", "jo@example.org");

    const stale = await sharePage(o, "quarterly-plan", "?revoke=sh_gone");
    expect(stale.status).toBe(200);
    expect(stale.html).toContain("That share is already gone.");
    expect(stale.html).toContain("jo@example.org");
    expect(stale.html).not.toContain("Revoke the share with jo@example.org?");
    expect(stale.html).toContain("Share by email");
  });

  it("refuses a post that did not come from the page and redraws the page saying so", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");

    const outside = await post(
      o,
      "quarterly-plan",
      { do: "email", address: "jo@example.org" },
      "https://elsewhere.test",
    );
    expect(outside.status).toBe(403);
    expect(outside.html).toContain("reload");
    expect(outside.html).toContain('class="flash bad"');
    expect((await sharePage(o, "quarterly-plan")).html).not.toContain("jo@example.org");
  });

  it("draws one card and no control at all where the deployment binds no share audience", async () => {
    const o = await owner("off");

    const page = await sharePage(o, "release-notes");
    expect(page.status).toBe(200);
    expect(page.html).toContain("Sharing is not configured for this deployment.");
    expect(page.html).toContain("ARTIFACT_SHARE_ACCESS_AUD");
    expect(page.html).toContain("not enabled");
    expect(page.html).not.toContain("<form");
    expect(page.html).not.toContain("<button");
    expect(page.html).toContain("Back to the artifacts");
  });

  it("says only an artifact's owner shares it, and names nothing about the artifact", async () => {
    const o = await owner();
    const bob = `bob-${crypto.randomUUID()}@example.com`;
    await o.h.invite(bob);
    await publishDocument(o.h.clientWithToken(await o.h.login(bob)), "panel-episode-99", "account");

    const page = await sharePage(o, "panel-episode-99");
    expect(page.status).toBe(403);
    expect(page.html).toContain("Only an artifact&#39;s owner shares it.");
    expect(page.html).toContain("not yours");
    expect(page.html).not.toContain("Quarterly plan");
    expect(page.html).not.toContain("r account");
    expect(page.html).not.toContain("<form");
    expect(page.html).not.toContain("<button");
  });

  it("answers the dashboard's own notice for a name that holds no artifact", async () => {
    const o = await owner();

    const page = await sharePage(o, "no-such-thing");
    expect(page.status).toBe(404);
    expect(page.html).toContain("No such artifact");
    expect(page.html).not.toContain('class="snav"');
  });

  it("carries a share count on the Artifacts row that is itself the link to the share page", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");
    await site(o.alice, "release-notes");
    await mint(o.alice, "quarterly-plan", "jo@example.org");

    const response = await o.h.send("/dashboard/artifacts", {
      headers: { "cf-access-jwt-assertion": o.dashboard },
    });
    const html = await response.text();
    expect(html).toContain(
      '<a href="/dashboard/artifacts/quarterly-plan/shares" aria-label="1 share on quarterly-plan">1 share</a>',
    );
    expect(html).toContain(
      '<a href="/dashboard/artifacts/release-notes/shares" aria-label="Share release-notes">Share</a>',
    );
  });
});

describe("an artifact's own page", () => {
  it("draws the owner's bar on a document and an audio page, and never on a site", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");
    await audio(o.alice, "panel-episode-12");
    await site(o.alice, "release-notes");
    await mint(o.alice, "quarterly-plan", "jo@example.org");

    const doc = await (await o.h.sendToArtifactHost("/a/quarterly-plan", o.host)).text();
    expect(doc).toContain("This artifact has 1 share.");
    expect(doc).toContain("Manage sharing");
    expect(doc).toContain('href="https://recall.test/dashboard/artifacts/quarterly-plan/shares"');
    expect(doc).toContain('target="_blank" rel="noreferrer"');

    const player = await (await o.h.sendToArtifactHost("/a/panel-episode-12", o.host)).text();
    expect(player).toContain("This artifact is shared with nobody.");
    expect(player).toContain("Share it");
    expect(player.indexOf('class="band"')).toBeLessThan(player.indexOf('role="group"'));

    const bytes = await (await o.h.sendToArtifactHost("/a/release-notes", o.host)).text();
    expect(bytes).not.toContain('class="band"');
    expect(bytes).toBe("<p>release notes</p>");
  });

  it("draws no bar for an invited reader who is not the owner, and sets no cookie for the owner", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan", "account");
    await mint(o.alice, "quarterly-plan", "jo@example.org");
    const bob = `bob-${crypto.randomUUID()}@example.com`;
    await o.h.invite(bob);

    const mine = await o.h.sendToArtifactHost("/a/quarterly-plan", o.host);
    expect(mine.headers.get("set-cookie")).toBe(null);
    expect(await mine.text()).toContain('class="band"');

    const theirs = await o.h.sendToArtifactHost("/a/quarterly-plan", await o.h.assertionFor(bob, ARTIFACT_AUDIENCE));
    const html = await theirs.text();
    expect(html).not.toContain('class="band"');
    expect(html).not.toContain("Manage sharing");
    expect(html).toContain("Quarterly plan");
    expect(html).toContain("The recall dashboard");
  });
});

describe("a page a recipient reaches", () => {
  it("draws the band on a document, keeps every address under the share, and ends with the body", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");
    const share = await mint(o.alice, "quarterly-plan");
    const base = basePath(share.address);

    const response = await read(o, base);
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain("This artifact was shared with you. The share stops working on");
    expect(html).toContain(`href="${base}" aria-current="page"`);
    expect(html).toContain(`href="${base}?view=raw"`);
    expect(html).toContain(`${base}/f/appendix.md`);
    expect(html).toContain(`${base}/f/cover.png`);
    expect(html).not.toContain(o.email);
    expect(html).not.toContain("read private");
    expect(html).not.toContain("The recall dashboard");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<script");
  });

  it("draws the same frame raw, and no band at all on a site", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");
    await site(o.alice, "release-notes");
    const doc = basePath((await mint(o.alice, "quarterly-plan")).address);
    const bytes = basePath((await mint(o.alice, "release-notes")).address);

    const raw = await (await read(o, `${doc}?view=raw`)).text();
    expect(raw).toContain("This artifact was shared with you.");
    expect(raw).toContain(`href="${doc}?view=raw" aria-current="page"`);
    expect(raw).toContain("# Quarterly plan");

    const served = await read(o, bytes);
    expect(await served.text()).toBe("<p>release notes</p>");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("streams a shared player's tracks under the share and tells a reader to ask the sender", async () => {
    const o = await owner();
    await audio(o.alice, "panel-episode-12");
    const base = basePath((await mint(o.alice, "panel-episode-12")).address);
    await o.h.dropArtifactFile(await o.h.userIdFor(o.email), "panel-episode-12", 1, "the-first-question.mp3");

    const html = await (await read(o, base)).text();
    expect(html).toContain(`"base":"${base}"`);
    expect(html).toContain(`src="${base}/player.js"`);
    expect(html).toContain("Ask whoever sent you this address about it.");
    expect(html).not.toContain("Republish the artifact");
    expect(html).not.toContain(o.email);
    expect(html).not.toContain("The recall dashboard");

    const script = await read(o, `${base}/player.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("answers one page for a dead share, with nothing to follow and no dashboard", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");
    const base = basePath((await mint(o.alice, "quarterly-plan")).address);
    o.h.tick(SHARE_WINDOW_MS + 1);

    const response = await read(o, base);
    expect(response.status).toBe(404);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain("This share is no longer available.");
    expect(html).toContain("Ask whoever sent you this address for a new one.");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("dashboard");
    expect(html).not.toContain("quarterly-plan");
    expect(html).not.toContain("Quarterly plan");
  });

  it("refuses a proven address the share does not name, and names neither address", async () => {
    const o = await owner();
    await publishDocument(o.alice, "quarterly-plan");
    const share = await mint(o.alice, "quarterly-plan", "jo@example.org");
    const base = basePath(share.address);

    const response = await read(o, base, await o.h.shareAssertionFor("someone-else@example.net"));
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain("This artifact was shared with another address.");
    expect(html).toContain("Sign in as another address");
    expect(html).toContain("/cdn-cgi/access/logout");
    expect(html).toContain("ends the sign-in to every page on this host");
    expect(html).not.toContain("jo@example.org");
    expect(html).not.toContain("someone-else@example.net");
    expect(html).not.toContain("Quarterly plan");
  });
});
