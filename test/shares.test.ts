import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ArtifactView } from "../src/artifacts";
import {
  hashShareToken,
  MAX_EMAIL_SHARES,
  newShareId,
  newShareToken,
  PLAYER_SEGMENT,
  parseShareAddress,
  SHARE_EMAIL_PREFIX,
  SHARE_LINK_PREFIX,
  SHARE_SOON_MS,
  SHARE_WINDOW_MS,
  type ShareView,
  shareTimeLeft,
} from "../src/shares";
import { ARTIFACT_AUDIENCE, type Client, harness } from "./harness";

const DAY = 86_400_000;

describe("the address an email share is made for", () => {
  it("lower-cases and trims what was typed, so one address is one share", () => {
    expect(parseShareAddress("  Reader@Example.COM ")).toEqual({ ok: true, value: "reader@example.com" });
    expect(parseShareAddress("reader+notes@mail.example.co.uk")).toEqual({
      ok: true,
      value: "reader+notes@mail.example.co.uk",
    });
  });

  it("refuses what is not an address, and says what one holds", () => {
    const refusals = [
      "",
      "reader",
      "reader@example",
      "reader@@example.com",
      "a b@example.com",
      `${"a".repeat(250)}@example.com`,
      42,
    ];
    for (const value of refusals) {
      const parsed = parseShareAddress(value);
      expect([value, parsed.ok]).toEqual([value, false]);
      if (parsed.ok) continue;
      expect(parsed.error).toContain("reader@example.com");
      expect(parsed.error).not.toContain("invalid");
    }
  });
});

describe("the time left on a share", () => {
  const now = 1_700_000_000_000;

  it("says nothing while the expiry is further out than the threshold", () => {
    expect(shareTimeLeft(now + SHARE_SOON_MS + 1, now)).toBe("");
    expect(shareTimeLeft(now + 30 * DAY, now)).toBe("");
  });

  it("counts down from the threshold itself", () => {
    expect(shareTimeLeft(now + SHARE_SOON_MS, now)).toBe("14 days left");
    expect(shareTimeLeft(now + DAY, now)).toBe("1 day left");
    expect(shareTimeLeft(now + 3_600_000, now)).toBe("1 hour left");
    expect(shareTimeLeft(now + 60_000, now)).toBe("1 minute left");
    expect(shareTimeLeft(now + 1, now)).toBe("1 minute left");
  });

  it("says nothing for a share already past its expiry, which no read returns", () => {
    expect(shareTimeLeft(now, now)).toBe("");
    expect(shareTimeLeft(now - DAY, now)).toBe("");
  });
});

interface Owner {
  h: Awaited<ReturnType<typeof harness>>;
  email: string;
  alice: Client;
  assertion: string;
}

const owner = async (sharing: "on" | "off" = "on"): Promise<Owner> => {
  const h = await harness({ sharing });
  const email = `alice-${crypto.randomUUID()}@example.com`;
  await h.invite(email);
  return {
    h,
    email,
    alice: h.clientWithToken(await h.login(email)),
    assertion: await h.assertionFor(email, ARTIFACT_AUDIENCE),
  };
};

const DOC = "# Quarterly plan\n\nOne paragraph.\n";

const document = (alice: Client, name: string, read = "private"): Promise<Response> =>
  alice.publishArtifact(name, {
    type: "document",
    title: "Quarterly plan",
    read,
    files: [{ path: "notes.md", body: DOC }],
  });

interface Made {
  share: ShareView;
  address: string;
  replaced?: boolean;
  renewed?: boolean;
}

const share = async (alice: Client, name: string, address?: string): Promise<Made> => {
  const body = address === undefined ? { mode: "link" } : { mode: "email", address };
  const response = await alice.request("POST", `/v2/artifacts/${encodeURIComponent(name)}/shares`, body);
  if (response.status !== 200) throw new Error(`share ${name}: ${response.status} ${await response.text()}`);
  return response.json();
};

const pathOf = (address: string): string => new URL(address).pathname;

const rowOf = async (shareId: string): Promise<{ uses: number; last_used_at: number } | null> =>
  env.DB.prepare("SELECT uses, last_used_at FROM artifact_shares WHERE share_id = ?").bind(shareId).first();

describe("a link share", () => {
  it("opens one artifact with no sign-in at all, and streams its files and script", async () => {
    const o = await owner();
    await o.alice.publishArtifact("episode-12", {
      type: "audio",
      files: [{ path: "track-01.mp3", body: "first-track-bytes" }],
    });
    const made = await share(o.alice, "episode-12");
    const base = pathOf(made.address);
    expect(base.startsWith(`${SHARE_LINK_PREFIX}/`)).toBe(true);

    const page = await o.h.sendToSharePrefix(base, null);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private, no-cache");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");

    expect((await o.h.sendToSharePrefix(`${base}/`, null)).status).toBe(200);
    expect((await o.h.sendToSharePrefix(`${base}/${PLAYER_SEGMENT}`, null)).status).toBe(200);

    const file = await o.h.sendToSharePrefix(`${base}/f/track-01.mp3`, null);
    expect(file.status).toBe(200);
    expect(file.headers.get("accept-ranges")).toBe("bytes");
    const part = await o.h.sendToSharePrefix(`${base}/f/track-01.mp3`, null, { headers: { range: "bytes=0-4" } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("first");
  });

  it("counts a page view and never a file read, and leaves the token unstored", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    const made = await share(o.alice, "quarterly-plan");
    const base = pathOf(made.address);
    const token = base.slice(SHARE_LINK_PREFIX.length + 1);

    expect(await rowOf(made.share.shareId)).toMatchObject({ uses: 0 });
    await o.h.sendToSharePrefix(base, null);
    await o.h.sendToSharePrefix(base, null);
    await o.h.sendToSharePrefix(`${base}/f/notes.md`, null);
    const row = await rowOf(made.share.shareId);
    expect(row?.uses).toBe(2);

    const stored = await env.DB.prepare("SELECT subject FROM artifact_shares WHERE share_id = ?")
      .bind(made.share.shareId)
      .first<{ subject: string }>();
    expect(stored?.subject).toBe(await hashShareToken(token));
    expect(stored?.subject).not.toContain(token);
  });

  it("costs an unknown token no write at all", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    const made = await share(o.alice, "quarterly-plan");

    const guessed = await o.h.sendToSharePrefix(`${SHARE_LINK_PREFIX}/${newShareToken()}`, null);
    expect(guessed.status).toBe(404);
    expect(await (await o.h.sendToSharePrefix(`${SHARE_LINK_PREFIX}/${newShareToken()}`, null)).text()).toContain(
      "This share is no longer available.",
    );
    expect(await rowOf(made.share.shareId)).toMatchObject({ uses: 0 });
  });

  it("answers an unknown, a revoked and an expired share with one page", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    await document(o.alice, "release-notes");
    const dead = pathOf((await share(o.alice, "quarterly-plan")).address);
    const revoked = pathOf((await share(o.alice, "release-notes")).address);

    const unknown = await o.h.sendToSharePrefix(`${SHARE_LINK_PREFIX}/${newShareToken()}`, null);
    await o.alice.request("DELETE", "/v2/artifacts/release-notes/shares?link");
    const gone = await o.h.sendToSharePrefix(revoked, null);
    o.h.tick(SHARE_WINDOW_MS + 1);
    const expired = await o.h.sendToSharePrefix(dead, null);

    expect([unknown.status, gone.status, expired.status]).toEqual([404, 404, 404]);
    const body = await unknown.text();
    expect(await gone.text()).toBe(body);
    expect(await expired.text()).toBe(body);
  });

  it("deletes the row a read found past its expiry, and sweeps nothing else", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    await document(o.alice, "release-notes");
    const dying = await share(o.alice, "quarterly-plan");
    o.h.tick(SHARE_WINDOW_MS - 1);
    const living = await share(o.alice, "release-notes");
    o.h.tick(2);

    expect((await o.h.sendToSharePrefix(pathOf(dying.address), null)).status).toBe(404);
    expect(await rowOf(dying.share.shareId)).toBe(null);
    expect(await rowOf(living.share.shareId)).not.toBe(null);
    expect((await o.h.sendToSharePrefix(pathOf(living.address), null)).status).toBe(200);
  });

  it("reaches one artifact and nothing else on the host", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    await document(o.alice, "release-notes");
    const base = pathOf((await share(o.alice, "quarterly-plan")).address);
    const other = pathOf((await share(o.alice, "release-notes")).address);

    const refused = [
      `${base}/f/nothing.md`,
      `${base}/notes.md`,
      `${base}/f`,
      `${base}/f/`,
      `${base}/elsewhere/notes.md`,
      `${SHARE_LINK_PREFIX}/`,
      `${SHARE_EMAIL_PREFIX}/${newShareId()}`,
    ];
    for (const path of refused) {
      expect([path, (await o.h.sendToSharePrefix(path, null)).status]).toEqual([path, 404]);
    }
    expect((await o.h.sendToSharePrefix(base, null, { method: "DELETE" })).status).toBe(405);
    expect((await o.h.sendToSharePrefix(base, null, { method: "POST" })).status).toBe(405);

    const theirs = await o.h.sendToSharePrefix(other, null);
    expect(theirs.status).toBe(200);
    expect(await theirs.text()).not.toContain("f/notes.md");
  });

  it("never falls through to another account's artifact of the same name", async () => {
    const o = await owner();
    const bob = `bob-${crypto.randomUUID()}@example.com`;
    await o.h.invite(bob);
    const bobs = o.h.clientWithToken(await o.h.login(bob));
    await bobs.publishArtifact("notes", {
      type: "document",
      title: "Bob's notes",
      read: "account",
      files: [{ path: "notes.md", body: "# Bob\n" }],
    });
    await o.alice.publishArtifact("notes", {
      type: "document",
      title: "Alice's notes",
      files: [{ path: "notes.md", body: "# Alice\n" }],
    });
    const base = pathOf((await share(o.alice, "notes")).address);

    const mine = await (await o.h.sendToSharePrefix(base, null)).text();
    expect(mine).toContain("Alice");
    expect(mine).not.toContain("Bob");

    expect((await o.alice.request("DELETE", "/v2/artifacts/notes")).status).toBe(204);
    expect((await o.h.sendToSharePrefix(base, null)).status).toBe(404);
  });

  it("survives a republish and dies with an unpublish", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    const made = await share(o.alice, "quarterly-plan");
    const base = pathOf(made.address);

    await o.alice.publishArtifact("quarterly-plan", {
      type: "document",
      replace: true,
      title: "Quarterly plan",
      files: [{ path: "notes.md", body: "# Redrawn\n" }],
    });
    expect(await (await o.h.sendToSharePrefix(base, null)).text()).toContain("Redrawn");

    expect((await o.alice.request("DELETE", "/v2/artifacts/quarterly-plan")).status).toBe(204);
    expect((await o.h.sendToSharePrefix(base, null)).status).toBe(404);
    expect(await rowOf(made.share.shareId)).toBe(null);
    await document(o.alice, "quarterly-plan");
    expect((await o.h.sendToSharePrefix(base, null)).status).toBe(404);
  });
});

describe("an email share", () => {
  it("opens only for the address it names, proven against its own audience", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    const made = await share(o.alice, "quarterly-plan", "Reader@Example.COM");
    const base = pathOf(made.address);
    expect(base).toBe(`${SHARE_EMAIL_PREFIX}/${made.share.shareId}`);
    expect(made.share.mode === "email" && made.share.address).toBe("reader@example.com");

    const proven = await o.h.sendToSharePrefix(base, await o.h.shareAssertionFor("reader@example.com"));
    expect(proven.status).toBe(200);
    expect((await o.h.sendToSharePrefix(base, await o.h.shareAssertionFor("READER@example.com"))).status).toBe(200);

    const elsewhere = await o.h.sendToSharePrefix(base, await o.h.shareAssertionFor("someone@example.net"));
    expect(elsewhere.status).toBe(403);
    expect((await o.h.sendToSharePrefix(base, null)).status).toBe(404);
    expect((await o.h.sendToSharePrefix(base, o.assertion)).status).toBe(404);
    expect((await o.h.sendToSharePrefix(base, await o.h.assertionFor(o.email))).status).toBe(404);
  });

  it("moves an expiry rather than writing a second row for one address", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    const first = await share(o.alice, "quarterly-plan", "reader@example.com");
    expect(first.renewed).toBe(false);
    o.h.tick(86_400_000);
    const again = await share(o.alice, "quarterly-plan", "reader@example.com");

    expect(again.renewed).toBe(true);
    expect(again.share.shareId).toBe(first.share.shareId);
    expect(again.share.expiresAt).toBeGreaterThan(first.share.expiresAt);
    const listed = await o.alice.request("GET", "/v2/artifacts/quarterly-plan/shares");
    const { shares }: { shares: ShareView[] } = await listed.json();
    expect(shares).toHaveLength(1);
  });

  it("holds twenty addresses per artifact and refuses the twenty-first", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    for (let index = 0; index < MAX_EMAIL_SHARES; index += 1) {
      await share(o.alice, "quarterly-plan", `reader-${index}@example.com`);
    }
    const refused = await o.alice.request("POST", "/v2/artifacts/quarterly-plan/shares", {
      mode: "email",
      address: "one-too-many@example.com",
    });
    expect(refused.status).toBe(409);
    expect((await refused.json<{ error: string }>()).error).toContain("the most one artifact takes");
    const renewed = await share(o.alice, "quarterly-plan", "reader-0@example.com");
    expect(renewed.renewed).toBe(true);
  });
});

describe("the share API", () => {
  it("lists one artifact's live shares, link first, and never a token", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    await share(o.alice, "quarterly-plan", "jo@example.org");
    o.h.tick(1_000);
    const link = await share(o.alice, "quarterly-plan");
    o.h.tick(1_000);
    await share(o.alice, "quarterly-plan", "reader@example.com");

    const response = await o.alice.request("GET", "/v2/artifacts/quarterly-plan/shares");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(pathOf(link.address).slice(SHARE_LINK_PREFIX.length + 1));
    const { shares }: { shares: ShareView[] } = JSON.parse(body);
    expect(shares.map((one) => one.mode)).toEqual(["link", "email", "email"]);
    expect(shares[0]).not.toHaveProperty("address");
    expect(shares.map((one) => (one.mode === "email" ? one.address : "the link"))).toEqual([
      "the link",
      "jo@example.org",
      "reader@example.com",
    ]);
  });

  it("replaces a link share rather than holding two", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    const first = await share(o.alice, "quarterly-plan");
    const second = await share(o.alice, "quarterly-plan");

    expect(first.replaced).toBe(false);
    expect(second.replaced).toBe(true);
    expect(second.address).not.toBe(first.address);
    expect((await o.h.sendToSharePrefix(pathOf(first.address), null)).status).toBe(404);
    expect((await o.h.sendToSharePrefix(pathOf(second.address), null)).status).toBe(200);
    const { shares }: { shares: ShareView[] } = await (
      await o.alice.request("GET", "/v2/artifacts/quarterly-plan/shares")
    ).json();
    expect(shares).toHaveLength(1);
  });

  it("revokes by id, by link, by address and all at once, and names the three", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    await share(o.alice, "quarterly-plan");
    const jo = await share(o.alice, "quarterly-plan", "jo@example.org");
    await share(o.alice, "quarterly-plan", "reader@example.com");

    const one = await o.alice.request("DELETE", `/v2/artifacts/quarterly-plan/shares/${jo.share.shareId}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ revoked: 1 });
    expect((await o.alice.request("DELETE", `/v2/artifacts/quarterly-plan/shares/${jo.share.shareId}`)).status).toBe(
      404,
    );

    const byLink = await o.alice.request("DELETE", "/v2/artifacts/quarterly-plan/shares?link");
    expect(await byLink.json()).toMatchObject({ revoked: 1 });

    const none = await o.alice.request("DELETE", "/v2/artifacts/quarterly-plan/shares");
    expect(none.status).toBe(400);
    expect((await none.json<{ error: string }>()).error).toContain("exactly one of link, email=<address> and all=true");
    const both = await o.alice.request("DELETE", "/v2/artifacts/quarterly-plan/shares?link&all=true");
    expect(both.status).toBe(400);

    const byAddress = await o.alice.request("DELETE", "/v2/artifacts/quarterly-plan/shares?email=Reader%40Example.com");
    const left: { revoked: number; shares: ShareView[] } = await byAddress.json();
    expect(left).toMatchObject({ revoked: 1, shares: [] });

    await share(o.alice, "quarterly-plan", "last@example.org");
    const all = await o.alice.request("DELETE", "/v2/artifacts/quarterly-plan/shares?all=true");
    expect(await all.json()).toMatchObject({ revoked: 1, shares: [] });
  });

  it("answers another account's artifact with one sentence, and a name it holds none with a 404", async () => {
    const o = await owner();
    const bob = `bob-${crypto.randomUUID()}@example.com`;
    await o.h.invite(bob);
    await document(o.h.clientWithToken(await o.h.login(bob)), "panel-episode-99", "account");

    const theirs = await o.alice.request("GET", "/v2/artifacts/panel-episode-99/shares");
    expect(theirs.status).toBe(403);
    expect((await theirs.json<{ error: string }>()).error).toBe("only an artifact's owner shares it");

    const missing = await o.alice.request("POST", "/v2/artifacts/no-such-thing/shares", { mode: "link" });
    expect(missing.status).toBe(404);
    expect((await o.alice.request("GET", "/v2/artifacts/quarterly-plan/shares")).status).toBe(404);
  });

  it("takes a device token and nothing else", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    const anonymous = await o.h.send("/v2/artifacts/quarterly-plan/shares");
    expect(anonymous.status).toBe(401);
  });

  it("carries every share on the account through one optional param on the listing", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    await document(o.alice, "release-notes");
    await document(o.alice, "panel-notes");
    await share(o.alice, "quarterly-plan", "jo@example.org");
    await share(o.alice, "release-notes");

    const counted = await o.alice.request("GET", "/v2/artifacts?sort=name");
    const { artifacts }: { artifacts: ArtifactView[] } = await counted.json();
    expect(artifacts.map((one) => [one.name, one.shareCount])).toEqual([
      ["panel-notes", 0],
      ["quarterly-plan", 1],
      ["release-notes", 1],
    ]);

    const page = await o.alice.request("GET", "/v2/artifacts?shares=true&sort=name&limit=2");
    const first: { artifacts: Array<ArtifactView & { shares: ShareView[] }>; nextCursor: string } = await page.json();
    expect(first.artifacts.map((one) => one.shares.length)).toEqual([0, 1]);
    expect(first.artifacts[1]?.shares[0]?.mode).toBe("email");
    const next = await o.alice.request(
      "GET",
      `/v2/artifacts?shares=true&sort=name&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    const rest: { artifacts: Array<ArtifactView & { shares: ShareView[] }> } = await next.json();
    expect(rest.artifacts.map((one) => [one.name, one.shares.length])).toEqual([["release-notes", 1]]);
  });

  it("extends a share by thirty days from the moment it is extended", async () => {
    const o = await owner();
    await document(o.alice, "quarterly-plan");
    const made = await share(o.alice, "quarterly-plan");
    expect(made.share.expiresAt).toBe(o.h.now() + SHARE_WINDOW_MS);

    o.h.tick(SHARE_WINDOW_MS - 86_400_000);
    const renewed = await share(o.alice, "quarterly-plan");
    expect(renewed.share.expiresAt).toBe(o.h.now() + SHARE_WINDOW_MS);
  });
});

describe("a name that reads like a route", () => {
  it("serves an artifact named a and one named f, and both their files", async () => {
    const o = await owner();
    for (const name of ["a", "f"]) {
      await o.alice.publishArtifact(name, {
        type: "document",
        title: `named ${name}`,
        files: [
          { path: "notes.md", body: `# ${name}\n` },
          { path: "cover.png", body: "bytes" },
        ],
      });
    }
    for (const name of ["a", "f"]) {
      const page = await o.h.sendToArtifactHost(`/a/${name}`, o.assertion);
      expect([name, page.status]).toEqual([name, 200]);
      expect(await page.text()).toContain(`named ${name}`);
      expect([name, (await o.h.sendToArtifactHost(`/a/${name}/f/cover.png`, o.assertion)).status]).toEqual([name, 200]);
    }
    const base = pathOf((await share(o.alice, "f")).address);
    expect((await o.h.sendToSharePrefix(`${base}/f/cover.png`, null)).status).toBe(200);
  });

  it("serves a file named player.js under the file segment and the script under the base", async () => {
    const o = await owner();
    await o.alice.publishArtifact("deck", {
      type: "document",
      files: [
        { path: "deck.md", body: "# Deck\n" },
        { path: "player.js", body: "console.log('publisher')" },
      ],
    });

    const theirs = await o.h.sendToArtifactHost(`/a/deck/f/${PLAYER_SEGMENT}`, o.assertion);
    expect(theirs.status).toBe(200);
    expect(await theirs.text()).toBe("console.log('publisher')");

    const ours = await o.h.sendToArtifactHost(`/a/deck/${PLAYER_SEGMENT}`, o.assertion);
    expect(ours.status).toBe(200);
    expect(ours.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await ours.text()).not.toContain("publisher");
  });

  it("answers an artifact named shares beside its own share collection", async () => {
    const o = await owner();
    await document(o.alice, "shares");
    await o.alice.publishArtifact("deck", {
      type: "document",
      files: [
        { path: "deck.md", body: "# Deck\n" },
        { path: "shares", body: "a file called shares" },
      ],
    });

    const read = await o.alice.request("GET", "/v2/artifacts/shares");
    expect(read.status).toBe(200);
    expect((await read.json<{ artifact: ArtifactView }>()).artifact.name).toBe("shares");

    const made = await share(o.alice, "shares");
    const listed = await o.alice.request("GET", "/v2/artifacts/shares/shares");
    const { shares }: { shares: ShareView[] } = await listed.json();
    expect(shares.map((one) => one.shareId)).toEqual([made.share.shareId]);

    const file = await o.alice.request("GET", "/v2/artifacts/deck/files/shares");
    expect(await file.text()).toBe("a file called shares");
    expect((await o.alice.request("GET", "/v2/artifacts/deck/elsewhere")).status).toBe(404);
    expect((await o.h.sendToArtifactHost("/a/shares", o.assertion)).status).toBe(200);
  });

  // SQLite binds at most a hundred parameters per statement, and the largest page the listing
  // takes is a hundred rows. Reading the shares of that page by one parameter per name was two
  // over, so the biggest page an account could ask for failed outright. Publishing the hundred
  // artifacts is the fixture and takes seconds, so this test takes a timeout of its own.
  it("reads the shares of the largest page the listing takes", async () => {
    const o = await owner();
    const names = Array.from({ length: 100 }, (_one, at) => `plan-${String(at).padStart(3, "0")}`);
    for (let at = 0; at < names.length; at += 10) {
      await Promise.all(names.slice(at, at + 10).map((name) => document(o.alice, name)));
    }
    await share(o.alice, "plan-000");

    const counted = await o.alice.request("GET", "/v2/artifacts?limit=100&sort=name");
    const listed = await o.alice.request("GET", "/v2/artifacts?limit=100&sort=name&shares=true");

    expect([counted.status, listed.status]).toEqual([200, 200]);
    const page = await counted.json<{ artifacts: ArtifactView[] }>();
    expect(page.artifacts).toHaveLength(100);
    expect(page.artifacts[0]?.shareCount).toBe(1);
    const held = await listed.json<{ artifacts: Array<{ name: string; shares: ShareView[] }> }>();
    expect(held.artifacts[0]?.shares).toHaveLength(1);
    expect(held.artifacts[1]?.shares).toHaveLength(0);
  }, 30_000);
});

describe("a deployment that binds no share audience", () => {
  it("shares nothing, answers both prefixes alike and counts every artifact at zero", async () => {
    const o = await owner("off");
    await document(o.alice, "quarterly-plan");

    const refused = await o.alice.request("POST", "/v2/artifacts/quarterly-plan/shares", { mode: "link" });
    expect(refused.status).toBe(404);
    expect((await refused.json<{ error: string }>()).error).toContain("binds no share audience");
    expect((await o.alice.request("GET", "/v2/artifacts/quarterly-plan/shares")).status).toBe(404);

    expect((await o.h.sendToSharePrefix(`${SHARE_LINK_PREFIX}/${newShareToken()}`, null)).status).toBe(404);
    expect((await o.h.sendToSharePrefix(`${SHARE_EMAIL_PREFIX}/${newShareId()}`, null)).status).toBe(404);

    const { artifacts }: { artifacts: ArtifactView[] } = await (await o.alice.request("GET", "/v2/artifacts")).json();
    expect(artifacts.map((one) => one.shareCount)).toEqual([0]);
    const page = await (await o.h.sendToArtifactHost("/a/quarterly-plan", o.assertion)).text();
    expect(page).not.toContain('class="band"');
  });
});
