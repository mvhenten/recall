import { describe, expect, it } from "vitest";
import { harness } from "./harness";

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
