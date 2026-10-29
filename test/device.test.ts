import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/device";
import { harness } from "./harness";

interface ListedDevice {
  deviceId: string;
  name: string;
  createdAt: number;
  lastUsedAt: number;
  current: boolean;
}

const grantError = async (response: Response): Promise<string> => {
  expect(response.status).toBe(400);
  const body: { error: string } = await response.json();
  return body.error;
};

const devicesOf = async (response: Response): Promise<ListedDevice[]> => {
  expect(response.status).toBe(200);
  const body: { devices: ListedDevice[] } = await response.json();
  return body.devices;
};

const email = (label: string): string => `${label}-${crypto.randomUUID()}@example.com`;

describe("device login", () => {
  it("issues a working token once the code is approved", async () => {
    const h = await harness();
    const started = await h.startDevice("work laptop");
    expect(started.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started).toMatchObject({
      verification_uri: "https://recall.test/device",
      verification_uri_complete: `https://recall.test/device?code=${started.user_code}`,
      expires_in: 600,
      interval: 5,
    });

    const approver = await h.assertionFor(email("alice"));
    const page = await h.openApproval(started.user_code.toLowerCase().replace("-", ""), approver);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("set-cookie")).toMatch(
      /^__Host-recall_csrf=[^;]+; Path=\/;.*Secure; HttpOnly; SameSite=Strict/,
    );
    const html = await page.text();
    expect(html).toContain("work laptop");
    expect(html).toContain(started.user_code);

    h.tick(5_000);
    expect(await grantError(await h.poll(started.device_code))).toBe("authorization_pending");

    expect((await h.decide(started.user_code, "approve", approver)).status).toBe(200);
    h.tick(5_000);
    const granted = await h.poll(started.device_code);
    expect(granted.status).toBe(200);
    const body: { access_token: string; token_type: string } = await granted.json();
    expect(body.token_type).toBe("Bearer");

    const client = h.clientWithToken(body.access_token);
    const saved = await client.save("first-note", { body: "hello from the device" });
    expect((await client.get("first-note")).memoryId).toBe(saved.memoryId);
    const [device] = await devicesOf(await client.request("GET", "/v1/devices"));
    expect(device).toMatchObject({ name: "work laptop", current: true, lastUsedAt: h.now() });

    h.tick(5_000);
    expect(await grantError(await h.poll(started.device_code))).toBe("invalid_grant");
  });

  it("maps the approver's email to the configured user id", async () => {
    const h = await harness();
    const configured = email("owner");
    const userId = `owner-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO principals (email, user_id) VALUES (?, ?)").bind(configured, userId).run();

    const first = h.clientWithToken(await h.login(configured.toUpperCase(), "desktop"));
    const second = h.clientWithToken(await h.login(configured, "laptop"));
    expect((await first.save("shared-note", {})).userId).toBe(userId);
    expect((await second.get("shared-note")).userId).toBe(userId);
    expect((await devicesOf(await second.request("GET", "/v1/devices"))).map((device) => device.name)).toEqual([
      "desktop",
      "laptop",
    ]);
  });

  it("answers access_denied after a deny and never issues a token", async () => {
    const h = await harness();
    const started = await h.startDevice();
    const denied = await h.decide(started.user_code, "deny", await h.assertionFor(email("alice")));
    expect(denied.status).toBe(200);
    h.tick(5_000);
    expect(await grantError(await h.poll(started.device_code))).toBe("access_denied");
    h.tick(5_000);
    expect(await grantError(await h.poll(started.device_code))).toBe("invalid_grant");
  });

  it("expires an unapproved code after ten minutes", async () => {
    const h = await harness();
    const started = await h.startDevice();
    const approver = await h.assertionFor(email("alice"));
    h.tick(600_000);
    expect(await grantError(await h.poll(started.device_code))).toBe("expired_token");
    expect((await h.openApproval(started.user_code, approver)).status).toBe(404);
    expect((await h.decide(started.user_code, "approve", approver, "any-csrf")).status).toBe(404);
  });

  it("answers slow_down to a poll inside the interval and widens the interval by five seconds each time", async () => {
    const h = await harness();
    const started = await h.startDevice();
    expect(await grantError(await h.poll(started.device_code))).toBe("slow_down");
    h.tick(6_000);
    expect(await grantError(await h.poll(started.device_code))).toBe("slow_down");
    h.tick(14_000);
    expect(await grantError(await h.poll(started.device_code))).toBe("slow_down");
    h.tick(20_000);
    expect(await grantError(await h.poll(started.device_code))).toBe("authorization_pending");
  });

  it("rejects malformed start and poll requests", async () => {
    const h = await harness();
    const noName = await h.clientWithHeaders({}).request("POST", "/v1/device/code", { device_name: "" });
    expect(await grantError(noName)).toBe("invalid_request");
    const wrongGrant = await h.clientWithHeaders({}).request("POST", "/v1/device/token", {
      grant_type: "password",
      device_code: "x".repeat(43),
    });
    expect(await grantError(wrongGrant)).toBe("unsupported_grant_type");
  });
});

describe("approval page", () => {
  it("refuses to approve without a valid Access JWT", async () => {
    const h = await harness();
    const started = await h.startDevice();
    const valid = await h.assertionFor(email("alice"));
    const csrf = await h.csrfOf(await h.openApproval(started.user_code, valid));
    const [header, payload] = valid.split(".");
    for (const assertion of [
      null,
      "not-a-jwt",
      await h.assertionFor(email("alice"), "another-app"),
      await h.assertionFor(email("alice"), undefined, Math.floor(Date.now() / 1000) - 3600),
      `${header}.${payload}.${"A".repeat(342)}`,
    ]) {
      expect((await h.decide(started.user_code, "approve", assertion, csrf)).status).toBe(401);
      expect((await h.openApproval(started.user_code, assertion)).status).toBe(401);
    }
    h.tick(5_000);
    expect(await grantError(await h.poll(started.device_code))).toBe("authorization_pending");
  });

  it("refuses a post whose CSRF token or origin does not match", async () => {
    const h = await harness();
    const started = await h.startDevice();
    const assertion = await h.assertionFor(email("alice"));
    const csrf = await h.csrfOf(await h.openApproval(started.user_code, assertion));
    const send = (origin: string, cookie: string, formCsrf: string): Promise<Response> =>
      h.send("/device", {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": assertion,
          origin,
          cookie: `__Host-recall_csrf=${cookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ user_code: started.user_code, action: "approve", csrf: formCsrf }),
      });
    expect((await send("https://evil.example", csrf, csrf)).status).toBe(403);
    expect((await send("https://recall.test", csrf, "forged")).status).toBe(403);
    expect((await send("https://recall.test", "forged", "forged-too")).status).toBe(403);
    h.tick(5_000);
    expect(await grantError(await h.poll(started.device_code))).toBe("authorization_pending");
    expect((await send("https://recall.test", csrf, csrf)).status).toBe(200);
  });

  it("answers 500, not 401, when the Access signing keys cannot be fetched", async () => {
    const h = await harness("down");
    const started = await h.startDevice();
    const response = await h.openApproval(started.user_code, await h.assertionFor(email("alice")));
    expect(response.status).toBe(500);
    const body: { error: string; requestId: string } = await response.json();
    expect(body.error).toBe("internal error");
    expect(body.requestId).not.toBe("");
  });
});

describe("device tokens", () => {
  it("cannot reach another user's memories or devices", async () => {
    const h = await harness();
    const alice = h.clientWithToken(await h.login(email("alice"), "alice-laptop"));
    const bob = h.clientWithToken(await h.login(email("bob"), "bob-laptop"));
    await alice.save("private-plan", { body: "alice only" });

    expect((await bob.request("GET", "/v1/memories/private-plan")).status).toBe(404);
    expect((await bob.request("DELETE", "/v1/memories/private-plan")).status).toBe(404);
    const [aliceDevice] = await devicesOf(await alice.request("GET", "/v1/devices"));
    expect((await devicesOf(await bob.request("GET", "/v1/devices"))).map((device) => device.name)).toEqual([
      "bob-laptop",
    ]);
    expect((await bob.request("DELETE", `/v1/devices/${aliceDevice?.deviceId}`)).status).toBe(404);
    expect((await alice.get("private-plan")).body).toBe("alice only");
  });

  it("answers 401 to a revoked, unknown or malformed token", async () => {
    const h = await harness();
    const owner = email("alice");
    const laptop = h.clientWithToken(await h.login(owner, "laptop"));
    const desktop = h.clientWithToken(await h.login(owner, "desktop"));
    const listed = await devicesOf(await desktop.request("GET", "/v1/devices"));
    const laptopId = listed.find((device) => device.name === "laptop")?.deviceId;

    expect((await desktop.request("DELETE", `/v1/devices/${laptopId}`)).status).toBe(204);
    const revoked = await laptop.request("GET", "/v1/memories");
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).toContain("run recall login");

    expect((await desktop.request("DELETE", "/v1/devices/current")).status).toBe(204);
    expect((await desktop.request("GET", "/v1/memories")).status).toBe(401);

    const malformed: Array<Record<string, string>> = [
      {},
      { authorization: `Bearer ${"A".repeat(43)}` },
      { authorization: "Basic abc" },
    ];
    for (const headers of malformed) {
      expect((await h.clientWithHeaders(headers).request("GET", "/v1/memories")).status).toBe(401);
    }
  });

  it("stores only the SHA-256 hash of a device token", async () => {
    const h = await harness();
    const token = await h.login(email("alice"), "hash-check");
    const rows = await env.DB.prepare("SELECT * FROM devices WHERE name = 'hash-check'").all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    const [row] = rows.results;
    expect(row?.token_sha256).toBe(await sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });
});

describe("service token fallback", () => {
  it("admits a registered service token by its hashed secret", async () => {
    const h = await harness();
    const clientId = `${crypto.randomUUID()}.access`;
    const secret = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO service_tokens (client_id, user_id, secret_sha256) VALUES (?, ?, ?)")
      .bind(clientId, `legacy-${crypto.randomUUID()}`, await sha256Hex(secret))
      .run();

    const legacy = h.clientWithHeaders({ "cf-access-client-id": clientId, "cf-access-client-secret": secret });
    expect((await legacy.save("legacy-note", {})).name).toBe("legacy-note");
    const wrong = h.clientWithHeaders({ "cf-access-client-id": clientId, "cf-access-client-secret": "wrong" });
    expect((await wrong.request("GET", "/v1/memories")).status).toBe(401);
  });
});
