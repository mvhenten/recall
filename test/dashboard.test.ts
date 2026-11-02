import { describe, expect, it } from "vitest";
import { DASHBOARD_AUDIENCE, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

interface ShellTab {
  path: string;
  label: string;
  heading: string;
  empty: string;
}

const TABS: ShellTab[] = [
  { path: "/dashboard", label: "Sessions", heading: "Live sessions", empty: "No host has a session open right now." },
  { path: "/dashboard/memory", label: "Memory", heading: "Memory", empty: "Nothing to browse here yet." },
  { path: "/dashboard/stats", label: "Stats", heading: "Stats", empty: "No usage has been recorded yet." },
  { path: "/dashboard/insights", label: "Insights", heading: "Insights", empty: "Nothing stands out yet." },
];

const email = (label: string): string => `${label}-${crypto.randomUUID()}@example.com`;

const open = (h: Harness, path: string, assertion: string | null): Promise<Response> =>
  h.send(path, { headers: assertion === null ? {} : { "cf-access-jwt-assertion": assertion } });

const signedIn = async (h: Harness, label = "owner"): Promise<{ email: string; assertion: string }> => {
  const address = await h.invite(email(label));
  return { email: address, assertion: await h.assertionFor(address, DASHBOARD_AUDIENCE) };
};

describe("the root path", () => {
  it("sends a browser to the dashboard", async () => {
    const h = await harness();
    const response = await h.send("/", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard");
  });

  it("keeps answering 404 JSON to every client that does not ask for HTML", async () => {
    const h = await harness();
    for (const accept of [undefined, "*/*", "application/json", "text/html;q=0"]) {
      const response = await h.send("/", accept === undefined ? {} : { headers: { accept } });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    }
  });
});

describe("the dashboard", () => {
  it("renders every tab of the shell for an invited email that Access verified", async () => {
    const h = await harness();
    const owner = await signedIn(h);
    for (const tab of TABS) {
      const response = await open(h, tab.path, owner.assertion);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await response.text();
      expect(html).toContain(owner.email);
      expect(html).toContain(`<h2>${tab.heading}</h2>`);
      expect(html).toContain(tab.empty);
      expect(html).toContain(`<a href="${tab.path}" aria-current="page">${tab.label}</a>`);
      for (const other of TABS.filter((candidate) => candidate !== tab)) {
        expect(html).toContain(`<a href="${other.path}">${other.label}</a>`);
      }
    }
  });

  it("has no page at an unknown dashboard address", async () => {
    const h = await harness();
    const owner = await signedIn(h);
    expect((await open(h, "/dashboard/costs", owner.assertion)).status).toBe(404);
  });

  it("refuses a request Cloudflare Access did not sign for the dashboard", async () => {
    const h = await harness();
    const address = await h.invite(email("owner"));
    for (const assertion of [
      null,
      "not-a-jwt",
      await h.assertionFor(address, "another-app"),
      await h.assertionFor(address, DASHBOARD_AUDIENCE, Math.floor(Date.now() / 1000) - 3600),
    ]) {
      expect((await open(h, "/dashboard", assertion)).status).toBe(401);
    }
  });

  it("refuses a verified email that is not invited", async () => {
    const h = await harness();
    const stranger = email("stranger");
    const response = await open(h, "/dashboard", await h.assertionFor(stranger, DASHBOARD_AUDIENCE));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(stranger);
  });

  it("serves the dashboard on GET only", async () => {
    const h = await harness();
    const owner = await signedIn(h);
    const response = await h.send("/dashboard", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": owner.assertion },
    });
    expect(response.status).toBe(405);
  });
});
