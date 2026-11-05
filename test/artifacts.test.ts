import { describe, expect, it } from "vitest";
import { type Artifact, MAX_ARTIFACT_BYTES } from "../src/artifacts";
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

  it("replaces a page under the same name and lists what it holds", async () => {
    const { h, alice, assertion } = await publisher();
    await alice.publish("burn-up", PAGE);
    const replaced: { artifact: Artifact } = await (await alice.publish("burn-up", "<p>redrawn</p>")).json();
    expect(replaced.artifact.url).toBe(`https://${ARTIFACT_HOSTNAME}/burn-up`);

    const listed = await alice.request("GET", "/v1/artifacts");
    const page: { artifacts: Artifact[] } = await listed.json();
    expect(page.artifacts).toHaveLength(1);
    expect(page.artifacts[0]?.name).toBe("burn-up");
    expect(page.artifacts[0]?.url).toBe(`https://${ARTIFACT_HOSTNAME}/burn-up`);
    expect(page.artifacts[0]?.bytes).toBe("<p>redrawn</p>".length);
    expect(await (await h.sendToArtifactHost("/burn-up", assertion)).text()).toBe("<p>redrawn</p>");

    expect((await alice.request("DELETE", "/v1/artifacts/burn-up")).status).toBe(204);
    expect((await h.sendToArtifactHost("/burn-up", assertion)).status).toBe(404);
  });

  it("refuses a page over the size ceiling", async () => {
    const { alice } = await publisher();
    expect((await alice.publish("too-big", new Uint8Array(MAX_ARTIFACT_BYTES + 1))).status).toBe(413);
    expect((await alice.publish("empty", "")).status).toBe(400);
  });
});

describe("the artifact hostname", () => {
  it("answers nothing but published pages", async () => {
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

  it("shows each user their own pages only", async () => {
    const { h, alice, assertion } = await publisher();
    await alice.publish("burn-up", PAGE);
    const bob = `bob-${crypto.randomUUID()}@example.com`;
    await h.invite(bob);

    expect((await h.sendToArtifactHost("/burn-up", await h.assertionFor(bob, ARTIFACT_AUDIENCE))).status).toBe(404);
    expect((await h.sendToArtifactHost("/burn-up", assertion)).status).toBe(200);
  });
});

const artifactsTab = async (h: Harness, assertion: string): Promise<string> => {
  const response = await h.send("/dashboard/artifacts", { headers: { "cf-access-jwt-assertion": assertion } });
  expect(response.status).toBe(200);
  return response.text();
};

describe("the artifacts tab", () => {
  it("lists the signed-in user's pages with the address each answers on, and no stranger's", async () => {
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

  it("tells a deployment that publishes no pages apart from an account that has published none", async () => {
    const on = await harness();
    const owner = `alice-${crypto.randomUUID()}@example.com`;
    await on.invite(owner);
    const empty = await artifactsTab(on, await on.assertionFor(owner));
    expect(empty).toContain("No page is published yet.");
    expect(empty).not.toContain("This deployment publishes no pages.");

    const off = await harness("up", DEVICE_CODE_LIMITS, "off");
    const elsewhere = `alice-${crypto.randomUUID()}@example.com`;
    await off.invite(elsewhere);
    const disabled = await artifactsTab(off, await off.assertionFor(elsewhere));
    expect(disabled).toContain("This deployment publishes no pages.");
    expect(disabled).not.toContain("No page is published yet.");
  });
});

describe("the main hostname", () => {
  it("never serves a published page at its own root", async () => {
    const { h, alice, assertion } = await publisher();
    await alice.publish("burn-up", PAGE);

    const response = await h.send("/burn-up", { headers: { "cf-access-jwt-assertion": assertion } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Burn-up");

    const dashboard = await h.send("/dashboard", { headers: { "cf-access-jwt-assertion": assertion } });
    expect(dashboard.status).toBe(401);

    const read = await alice.request("GET", "/v1/artifacts/burn-up");
    expect(await read.text()).toBe(PAGE);
    expect(read.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });
});
