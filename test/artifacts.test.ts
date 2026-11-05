import { describe, expect, it } from "vitest";
import type { ArtifactView } from "../src/artifacts";
import { DEVICE_CODE_LIMITS } from "../src/device";
import { ARTIFACT_AUDIENCE, ARTIFACT_HOSTNAME, type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

const PAGE = `<!doctype html><html lang="en"><head><title>burn-up</title><style>body{color:#0f0}</style></head>
<body><h1>Burn-up</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><script>document.title="drawn"</script></body></html>`;

const publisher = async () => {
  const h = await harness();
  const email = `alice-${crypto.randomUUID()}@example.com`;
  await h.invite(email);
  const alice: Client = h.clientWithToken(await h.login(email));
  const assertion = await h.assertionFor(email, ARTIFACT_AUDIENCE);
  return { h, email, alice, assertion };
};

const listed = async (
  alice: Client,
  query = "",
): Promise<{ artifacts: ArtifactView[]; total: number; cut: boolean; nextCursor: string }> => {
  const response = await alice.request("GET", `/v1/artifacts${query}`);
  expect(response.status).toBe(200);
  return response.json();
};

describe("publishing", () => {
  it("serves the stored bytes raw on the artifact hostname", async () => {
    const { h, alice, assertion } = await publisher();
    expect((await alice.publish("burn-up", PAGE)).status).toBe(200);

    const response = await h.sendToArtifactHost("/burn-up", assertion);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts allow-downloads");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("img-src data: blob:");
  });

  it("records the type, the metadata and the permissions the manifest names", async () => {
    const { alice } = await publisher();
    const published = await alice.publishArtifact("q3-notes", {
      type: "document",
      title: "Q3 notes",
      description: "what the quarter did",
      read: "account",
      write: "account",
      files: [{ path: "notes.md", body: "# Q3\n\nIt went well.\n" }],
    });
    expect(published.status).toBe(200);
    const { artifact }: { artifact: ArtifactView } = await published.json();
    expect(artifact).toMatchObject({
      name: "q3-notes",
      type: "document",
      title: "Q3 notes",
      description: "what the quarter did",
      read: "account",
      write: "account",
      fileCount: 1,
      url: `https://${ARTIFACT_HOSTNAME}/q3-notes`,
    });

    const read = await alice.request("GET", "/v1/artifacts/q3-notes");
    expect(read.status).toBe(200);
    const found: { artifact: ArtifactView } = await read.json();
    expect(found.artifact.type).toBe("document");
    expect(found.artifact.lastWriter).toContain("@example.com");
  });

  it("refuses a type, a permission, a title and a path the service does not take", async () => {
    const { alice } = await publisher();
    const refusals = await Promise.all([
      alice.publishArtifact("a", { type: "slideshow" }),
      alice.publishArtifact("b", { read: "world" }),
      alice.publishArtifact("c", { write: "anyone" }),
      alice.publishArtifact("d", { title: "x".repeat(201) }),
      alice.publishArtifact("e", { files: [{ path: "../etc/passwd", body: "x" }] }),
      alice.publishArtifact("f", { files: [] }),
      alice.publishArtifact("g", { type: "audio", files: [{ path: "track.txt", body: "x" }] }),
      alice.publishArtifact("h", { type: "document", files: [{ path: "notes.txt", body: "x" }] }),
    ]);
    expect(refusals.map((one) => one.status)).toEqual([400, 400, 400, 400, 400, 400, 400, 400]);
    const [type, read] = await Promise.all([refusals[0]?.json(), refusals[1]?.json()]);
    expect((type as { error: string }).error).toContain("site, document, audio");
    expect((read as { error: string }).error).toContain("private, account");
  });

  it("refuses a second publish under one name and changes nothing", async () => {
    const { h, alice, assertion } = await publisher();
    await alice.publish("burn-up", PAGE);
    const again = await alice.publish("burn-up", "<p>redrawn</p>");
    expect(again.status).toBe(409);
    const refused: { error: string; artifact: { type: string; bytes: number } } = await again.json();
    expect(refused.error).toContain("burn-up already holds a site artifact");
    expect(refused.error).toContain("--replace");
    expect(refused.artifact.bytes).toBe(PAGE.length);
    expect(await (await h.sendToArtifactHost("/burn-up", assertion)).text()).toBe(PAGE);

    const replaced = await alice.publishArtifact("burn-up", {
      replace: true,
      files: [{ path: "index.html", body: "<p>redrawn</p>" }],
    });
    expect(replaced.status).toBe(200);
    expect(await (await h.sendToArtifactHost("/burn-up", assertion)).text()).toBe("<p>redrawn</p>");

    const page = await listed(alice);
    expect(page.artifacts).toHaveLength(1);
    expect(page.artifacts[0]?.bytes).toBe("<p>redrawn</p>".length);

    expect((await alice.request("DELETE", "/v1/artifacts/burn-up")).status).toBe(204);
    expect((await h.sendToArtifactHost("/burn-up", assertion)).status).toBe(404);
    expect((await alice.request("DELETE", "/v1/artifacts/burn-up")).status).toBe(404);
  });

  it("holds the files of a replacement under their own revision", async () => {
    const { h, alice, assertion } = await publisher();
    await alice.publishArtifact("deck", {
      files: [
        { path: "index.html", body: "<p>one</p>" },
        { path: "style.css", body: "p{color:red}" },
      ],
    });
    await alice.publishArtifact("deck", { replace: true, files: [{ path: "index.html", body: "<p>two</p>" }] });

    expect(await (await h.sendToArtifactHost("/deck", assertion)).text()).toBe("<p>two</p>");
    expect((await h.sendToArtifactHost("/deck/style.css", assertion)).status).toBe(404);
    const page = await listed(alice);
    expect(page.artifacts[0]?.fileCount).toBe(1);
  });
});

describe("the artifact hostname", () => {
  it("answers nothing but published artifacts", async () => {
    const { h, alice, assertion } = await publisher();
    await alice.publish("burn-up", PAGE);

    for (const path of ["/v1/memories", "/v1/artifacts", "/dashboard", "/dashboard/stats", "/device", "/"]) {
      const response = await h.sendToArtifactHost(path, assertion);
      expect([path, response.status]).toEqual([path, 404]);
    }
    expect((await h.sendToArtifactHost("/burn-up", assertion, { method: "DELETE" })).status).toBe(405);
  });

  it("takes an Access sign-in for its own application alone", async () => {
    const { h, email, alice, assertion } = await publisher();
    await alice.publish("burn-up", PAGE);

    expect((await h.sendToArtifactHost("/burn-up", null)).status).toBe(401);
    expect((await h.sendToArtifactHost("/burn-up", await h.assertionFor(email))).status).toBe(401);
    expect((await h.sendToArtifactHost("/burn-up", assertion)).status).toBe(200);
  });

  it("names the email it has not invited", async () => {
    const { h, alice } = await publisher();
    await alice.publish("burn-up", PAGE);
    const stranger = `nobody-${crypto.randomUUID()}@example.com`;
    const response = await h.sendToArtifactHost("/burn-up", await h.assertionFor(stranger, ARTIFACT_AUDIENCE));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(stranger);
  });

  it("answers a refused read and a missing name alike", async () => {
    const { h, alice, assertion } = await publisher();
    await alice.publish("burn-up", PAGE);
    const bob = `bob-${crypto.randomUUID()}@example.com`;
    await h.invite(bob);
    const theirs = await h.assertionFor(bob, ARTIFACT_AUDIENCE);

    const refused = await h.sendToArtifactHost("/burn-up", theirs);
    const missing = await h.sendToArtifactHost("/no-such-thing", theirs);
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe(await missing.text());
    expect((await h.sendToArtifactHost("/burn-up", assertion)).status).toBe(200);
  });

  it("serves an account-readable artifact to another invited reader", async () => {
    const { h, alice } = await publisher();
    await alice.publishArtifact("shared-notes", {
      read: "account",
      files: [{ path: "index.html", body: "<p>shared</p>" }],
    });
    const bob = `bob-${crypto.randomUUID()}@example.com`;
    await h.invite(bob);
    const response = await h.sendToArtifactHost("/shared-notes", await h.assertionFor(bob, ARTIFACT_AUDIENCE));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>shared</p>");
  });

  it("renders a document, links its raw view and serves its own files", async () => {
    const { h, alice, assertion } = await publisher();
    await alice.publishArtifact("spec", {
      type: "document",
      title: "The spec",
      description: "what it does",
      files: [
        { path: "spec.md", body: "# Heading\n\nA [link](notes.md) and <b>markup</b>.\n" },
        { path: "notes.md", body: "# Notes\n" },
      ],
    });

    const rendered = await h.sendToArtifactHost("/spec", assertion);
    expect(rendered.status).toBe(200);
    const html = await rendered.text();
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain('href="/spec/notes.md"');
    expect(html).toContain("&lt;b&gt;markup&lt;/b&gt;");
    expect(html).toContain("The spec");
    expect(html).toContain("what it does");
    expect(html).not.toContain("<script");
    expect(rendered.headers.get("content-security-policy") ?? "").toContain("default-src 'none'");

    const raw = await h.sendToArtifactHost("/spec?view=raw", assertion);
    expect(await raw.text()).toContain("# Heading");

    const file = await h.sendToArtifactHost("/spec/notes.md", assertion);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await file.text()).toBe("# Notes\n");
  });

  it("lists an audio artifact's tracks in publish order and answers a range request", async () => {
    const { h, alice, assertion } = await publisher();
    await alice.publishArtifact("episode-12", {
      type: "audio",
      title: "Episode 12",
      files: [
        { path: "track-01.mp3", body: "first-track-bytes" },
        { path: "track-02.mp3", body: "second-track-bytes" },
      ],
    });

    const player = await h.sendToArtifactHost("/episode-12", assertion);
    expect(player.status).toBe(200);
    const html = await player.text();
    expect(html.indexOf("track-01.mp3")).toBeLessThan(html.indexOf("track-02.mp3"));
    expect(html).toContain("2 tracks");

    const whole = await h.sendToArtifactHost("/episode-12/track-01.mp3", assertion);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/mpeg");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");

    const part = await h.sendToArtifactHost("/episode-12/track-01.mp3", assertion, { headers: { range: "bytes=0-4" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 0-4/17");
    expect(await part.text()).toBe("first");
  });

  it("serves the player's script at one address no artifact can hold", async () => {
    const { h, assertion } = await publisher();
    const response = await h.sendToArtifactHost("/player.js", assertion);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });
});

const artifactsTab = async (h: Harness, assertion: string, query = ""): Promise<string> => {
  const response = await h.send(`/dashboard/artifacts${query}`, {
    headers: { "cf-access-jwt-assertion": assertion },
  });
  expect(response.status).toBe(200);
  return response.text();
};

describe("the artifacts tab", () => {
  it("lists the signed-in user's artifacts with the address each answers on, and no stranger's", async () => {
    const { h, email, alice } = await publisher();
    await alice.publish("burn-up", "<p>burn-up</p>");
    await alice.publish("q3-report", PAGE);
    const bob = `bob-${crypto.randomUUID()}@example.com`;
    await h.invite(bob);
    await h.clientWithToken(await h.login(bob)).publish("bobs-ledger", PAGE);

    const html = await artifactsTab(h, await h.assertionFor(email));
    expect(html).toContain(`href="https://${ARTIFACT_HOSTNAME}/burn-up"`);
    expect(html).toContain(`href="https://${ARTIFACT_HOSTNAME}/q3-report"`);
    expect(html).toContain("14 B");
    expect(html).not.toContain("bobs-ledger");
  });

  it("tells a deployment that publishes no artifacts apart from an account that has published none", async () => {
    const on = await harness();
    const owner = `alice-${crypto.randomUUID()}@example.com`;
    await on.invite(owner);
    const empty = await artifactsTab(on, await on.assertionFor(owner));
    expect(empty).toContain("No artifact is published yet.");
    expect(empty).not.toContain("This deployment publishes no artifacts.");

    const off = await harness("up", DEVICE_CODE_LIMITS, "off");
    const elsewhere = `alice-${crypto.randomUUID()}@example.com`;
    await off.invite(elsewhere);
    const disabled = await artifactsTab(off, await off.assertionFor(elsewhere));
    expect(disabled).toContain("This deployment publishes no artifacts.");
    expect(disabled).not.toContain("No artifact is published yet.");
  });

  it("narrows by type, searches and sorts off the same address the API pages", async () => {
    const { h, email, alice } = await publisher();
    await alice.publishArtifact("alpha-site", { files: [{ path: "index.html", body: "<p>a</p>" }] });
    await alice.publishArtifact("beta-notes", {
      type: "document",
      title: "Beta notes",
      description: "a longer document about rollout",
      files: [{ path: "notes.md", body: "# Beta\n" }],
    });

    const filtered = await artifactsTab(h, await h.assertionFor(email), "?type=document");
    expect(filtered).toContain("beta-notes");
    expect(filtered).not.toContain("alpha-site");

    const searched = await artifactsTab(h, await h.assertionFor(email), "?q=rollout");
    expect(searched).toContain("beta-notes");
    expect(searched).not.toContain("alpha-site");

    const sorted = await listed(alice, "?sort=name");
    expect(sorted.artifacts.map((one) => one.name)).toEqual(["alpha-site", "beta-notes"]);
    expect(sorted.total).toBe(2);

    const paged = await listed(alice, "?limit=1&sort=name");
    expect(paged.artifacts.map((one) => one.name)).toEqual(["alpha-site"]);
    expect(paged.nextCursor).not.toBe("");
    const next = await listed(alice, `?limit=1&sort=name&cursor=${encodeURIComponent(paged.nextCursor)}`);
    expect(next.artifacts.map((one) => one.name)).toEqual(["beta-notes"]);

    const byQuery = await listed(alice, "?q=rollout");
    expect(byQuery.artifacts.map((one) => one.name)).toEqual(["beta-notes"]);
    expect(byQuery.cut).toBe(false);
  });

  it("reads a page link from an order it no longer holds as page one", async () => {
    const { h, email, alice } = await publisher();
    await alice.publish("burn-up", PAGE);
    const html = await artifactsTab(h, await h.assertionFor(email), "?cursor=not-a-cursor&sort=nonsense");
    expect(html).toContain("burn-up");
    expect(html).toContain("newest first");
  });
});

describe("a write permission", () => {
  const twoUsers = async () => {
    const { h, alice, assertion } = await publisher();
    const bobEmail = `bob-${crypto.randomUUID()}@example.com`;
    await h.invite(bobEmail);
    const bob = h.clientWithToken(await h.login(bobEmail));
    return { h, alice, bob, assertion };
  };

  it("refuses another account's device token and names nothing stored", async () => {
    const { alice, bob } = await twoUsers();
    await alice.publishArtifact("owned-ledger", {
      read: "account",
      write: "owner",
      files: [{ path: "index.html", body: "<p>mine</p>" }],
    });
    const refused = await bob.publishArtifact("owned-ledger", {
      replace: true,
      files: [{ path: "index.html", body: "<p>theirs</p>" }],
    });
    expect(refused.status).toBe(403);
    const body: { error: string } = await refused.json();
    expect(body.error).toContain("owner");
    expect(body.error).not.toContain("site");
    expect((await bob.request("DELETE", "/v1/artifacts/owned-ledger")).status).toBe(403);
  });

  it("lets another account replace an artifact written for the account", async () => {
    const { h, alice, bob, assertion } = await twoUsers();
    await alice.publishArtifact("shared-ledger", {
      read: "account",
      write: "account",
      files: [{ path: "index.html", body: "<p>mine</p>" }],
    });
    const replaced = await bob.publishArtifact("shared-ledger", {
      replace: true,
      read: "account",
      write: "account",
      files: [{ path: "index.html", body: "<p>theirs</p>" }],
    });
    expect(replaced.status).toBe(200);
    expect(await (await h.sendToArtifactHost("/shared-ledger", assertion)).text()).toBe("<p>theirs</p>");
  });
});

describe("the main hostname", () => {
  it("never serves a published artifact at its own root", async () => {
    const { h, alice, assertion } = await publisher();
    await alice.publish("burn-up", PAGE);

    const response = await h.send("/burn-up", { headers: { "cf-access-jwt-assertion": assertion } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Burn-up");

    const dashboard = await h.send("/dashboard", { headers: { "cf-access-jwt-assertion": assertion } });
    expect(dashboard.status).toBe(401);

    const file = await alice.request("GET", "/v1/artifacts/burn-up/index.html");
    expect(await file.text()).toBe(PAGE);
    expect(file.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});

describe("adopting what was published before a row carried a type", () => {
  it("reads at its old address, then lists once the operator adopts it", async () => {
    const { h, email, alice, assertion } = await publisher();
    await h.writeLegacyArtifact(await h.userIdFor(email), "old-page", "<p>from before</p>");

    const served = await h.sendToArtifactHost("/old-page", assertion);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("<p>from before</p>");
    expect((await listed(alice)).artifacts).toHaveLength(0);

    const adopted = await alice.request("POST", "/v1/artifacts/adopt");
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toEqual({ adopted: 1 });

    const page = await listed(alice);
    expect(page.artifacts.map((one) => one.name)).toEqual(["old-page"]);
    expect(page.artifacts[0]?.type).toBe("site");
    expect(await (await h.sendToArtifactHost("/old-page", assertion)).text()).toBe("<p>from before</p>");

    const again = await alice.request("POST", "/v1/artifacts/adopt");
    expect(await again.json()).toEqual({ adopted: 0 });
  });
});
