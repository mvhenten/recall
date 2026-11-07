import { describe, expect, it } from "vitest";
import { harness } from "./harness";

interface V2Session {
  sessionId: string;
  mode: string;
  hostLabel: string;
  startedAt: string;
  lastActivityAt: string;
  current: boolean;
}

interface V2Device {
  deviceId: string;
  host: string;
  hostLabel: string;
  current: boolean;
}

const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

describe("the /v2 surface", () => {
  it("takes a token /v1 issued", async () => {
    const { invite, login, clientWithToken } = await harness();
    const email = await invite(`crossing-${crypto.randomUUID()}@example.com`);
    const client = clientWithToken(await login(email));

    // The same bearer, against both surfaces. A device row is looked up by the digest of its token
    // and knows nothing about paths, so an updated CLI carries its login across unchanged.
    expect((await client.request("GET", "/v1/devices")).status).toBe(200);
    expect((await client.request("GET", "/v2/devices")).status).toBe(200);
  });

  it("refuses a request carrying no token", async () => {
    const { send } = await harness();
    expect((await send("/v2/devices")).status).toBe(401);
    expect((await send("/v2/history")).status).toBe(401);
  });

  it("signs a device in over the same RFC 8628 shape /v1 serves", async () => {
    const { send } = await harness();
    const started = await send("/v2/device/code", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": crypto.randomUUID() },
      body: JSON.stringify({ device_name: "laptop" }),
    });
    expect(started.status).toBe(200);
    const granted: Record<string, unknown> = await started.json();
    expect(Object.keys(granted).sort()).toEqual([
      "device_code",
      "expires_in",
      "interval",
      "user_code",
      "verification_uri",
      "verification_uri_complete",
    ]);

    const polled = await send("/v2/device/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: String(granted.device_code),
      }),
    });
    expect(polled.status).toBe(400);
    expect(await polled.json()).toMatchObject({ error: "authorization_pending" });
  });

  it("names a session's mode and dates it with an offset", async () => {
    const { user } = await harness();
    const client = await user("shapes");
    const session = crypto.randomUUID();
    expect((await client.v2.sync(session)).status).toBe(204);

    const listed = await client.request("GET", "/v2/sessions");
    expect(listed.status).toBe(200);
    const { sessions }: { sessions: V2Session[] } = await listed.json();
    const found = sessions.find((held) => held.sessionId === session);
    expect(found?.mode).toBe("Interactive");
    expect(found?.startedAt).toMatch(OFFSET);
    expect(found?.lastActivityAt).toMatch(OFFSET);
    expect(found?.current).toBe(true);
  });

  it("calls a host by its own name where its owner labelled none", async () => {
    const { user } = await harness();
    const client = await user("labels");
    const session = crypto.randomUUID();
    await client.v2.sync(session, { host: "core-box" });

    const devices = await client.request("GET", "/v2/devices");
    const { devices: held }: { devices: V2Device[] } = await devices.json();
    expect(held).toHaveLength(1);
    expect(held[0]?.hostLabel).toBe(held[0]?.host);
    expect(held[0]?.hostLabel).not.toBe("");

    const sessions = await client.request("GET", "/v2/sessions");
    const { sessions: live }: { sessions: V2Session[] } = await sessions.json();
    expect(live.find((one) => one.sessionId === session)?.hostLabel).toBe("core-box");
  });

  it("takes a mode it does not know for a refusal rather than a default", async () => {
    const { user } = await harness();
    const client = await user("modes");
    const refused = await client.v2.sync(crypto.randomUUID(), { mode: "interactive" });
    expect(refused.status).toBe(400);
    expect((await client.v2.sync(crypto.randomUUID(), { mode: "Unknown" })).status).toBe(204);
  });

  it("refuses a date that names no offset", async () => {
    const { user } = await harness();
    const client = await user("dates");
    const refused = await client.v2.sync(crypto.randomUUID(), { startedAt: "2023-11-14T22:13:20" });
    expect(refused.status).toBe(400);
    expect((await client.v2.sync(crypto.randomUUID(), { startedAt: 1_700_000_000_000 })).status).toBe(400);
  });

  it("requires a usage delta to say whether it is durable and which files it counted", async () => {
    const { user } = await harness();
    const client = await user("usage");
    const session = crypto.randomUUID();
    await client.v2.sync(session);

    expect((await client.v2.usage(session)).status).toBe(204);

    const partial = await client.v2.request("POST", `/v2/sessions/${session}/usage`, {
      seq: 2,
      host: "laptop",
      repo: "",
      provider: "anthropic",
      account: "work",
      model: "claude-opus-4",
      prompts: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 1,
      cacheReadTokens: 1,
      at: new Date(1_700_000_060_000).toISOString(),
    });
    expect(partial.status).toBe(400);
    expect(await partial.text()).toContain("durable");
  });

  it("reaches a session whose id is the word live", async () => {
    const { user } = await harness();
    const client = await user("ambiguous");
    for (const sessionId of ["live", "history", "search"]) {
      expect((await client.v2.sync(sessionId)).status).toBe(204);
      const read = await client.v2.session(sessionId);
      expect(read.status).toBe(200);
      const { session }: { session: { sessionId: string } } = await read.json();
      expect(session.sessionId).toBe(sessionId);
    }
  });

  it("serves every session on record from its own collection", async () => {
    const { user } = await harness();
    const client = await user("history");
    const session = crypto.randomUUID();
    await client.v2.sync(session);

    const listed = await client.request("GET", "/v2/history");
    expect(listed.status).toBe(200);
    const { sessionIds }: { sessionIds: string[] } = await listed.json();
    expect(sessionIds).toContain(session);

    expect((await client.request("GET", "/v2/history/anything")).status).toBe(404);
  });

  it("serves a session's transcript files from their own path", async () => {
    const { user } = await harness();
    const client = await user("files");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    await client.archive(session, "main", 0, '{"type":"user","message":{"content":"hello"}}\n');

    const listed = await client.v2.files(session);
    expect(listed.status).toBe(200);
    const { files }: { files: Array<{ file: string }> } = await listed.json();
    expect(files.map((held) => held.file)).toEqual(["main"]);

    // The transcript path serves one named file and nothing else; the listing moved out of it.
    const unnamed = await client.v2.request("GET", `/v2/sessions/${session}/transcript`);
    expect(unnamed.status).toBe(400);
    const named = await client.v2.request("GET", `/v2/sessions/${session}/transcript?file=main`);
    expect(named.status).toBe(200);
    expect(await named.text()).toContain("hello");
  });

  it("serves no transcript write at all", async () => {
    const { user } = await harness();
    const client = await user("writes");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const refused = await client.v2.request("PUT", `/v2/sessions/${session}/transcript?file=main&offset=0&through=1`);
    expect(refused.status).toBe(405);
  });

  it("revokes a device by its own id and not by a word meaning whoever asked", async () => {
    const { user } = await harness();
    const client = await user("revoking");
    const listed = await client.request("GET", "/v2/devices");
    const { devices }: { devices: V2Device[] } = await listed.json();
    const mine = devices.find((device) => device.current);
    expect(mine).toBeDefined();

    expect((await client.request("DELETE", "/v2/devices/current")).status).toBe(404);
    expect((await client.request("DELETE", `/v2/devices/${mine?.deviceId}`)).status).toBe(204);
    expect((await client.request("GET", "/v2/devices")).status).toBe(401);
  });

  it("addresses a message to a host or to a session and never to both", async () => {
    const { user } = await harness();
    const client = await user("messages");
    const session = crypto.randomUUID();
    await client.v2.sync(session);
    const { devices }: { devices: V2Device[] } = await (await client.request("GET", "/v2/devices")).json();
    const deviceId = devices[0]?.deviceId ?? "";

    const toHost = await client.v2.request("POST", "/v2/messages", {
      kind: "news",
      address: { scope: "host", target: deviceId },
      fromSessionId: "",
      body: "the fleet is up",
    });
    expect(toHost.status).toBe(201);
    expect(await toHost.json()).toMatchObject({ message: { toDeviceId: deviceId, toSessionId: "" } });

    const toSession = await client.v2.request("POST", "/v2/messages", {
      kind: "news",
      address: { scope: "session", target: session },
      fromSessionId: "",
      body: "yours alone",
    });
    expect(toSession.status).toBe(201);
    expect(await toSession.json()).toMatchObject({ message: { toDeviceId: deviceId, toSessionId: session } });

    const nowhere = await client.v2.request("POST", "/v2/messages", {
      kind: "news",
      address: { scope: "session", target: crypto.randomUUID() },
      fromSessionId: "",
      body: "into the void",
    });
    expect(nowhere.status).toBe(404);

    const legacy = await client.v2.request("POST", "/v2/messages", {
      kind: "news",
      toDeviceId: deviceId,
      toSessionId: "",
      body: "the old shape",
    });
    expect(legacy.status).toBe(400);
  });

  it("serves the board, artifacts and the socket under /v2 unchanged", async () => {
    const { user } = await harness();
    const client = await user("transcribed");
    const session = crypto.randomUUID();
    await client.v2.sync(session);

    const posted = await client.v2.request("POST", "/v2/board", { scope: "fleet", body: "read me" });
    expect(posted.status).toBe(201);
    const read = await client.request("GET", "/v2/board");
    expect(read.status).toBe(200);
    const { entries }: { entries: Array<{ message: { body: string } }> } = await read.json();
    expect(entries.map((entry) => entry.message.body)).toContain("read me");

    const taken = await client.v2.request("POST", "/v2/board/pickup", { sessionId: session });
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ messages: [{ body: "read me" }] });

    expect((await client.request("GET", "/v2/artifacts")).status).toBe(200);
    expect((await client.request("GET", "/v2/messages/listen")).status).toBe(426);
  });

  it("serves no memory operations yet", async () => {
    const { user } = await harness();
    const client = await user("memories");
    expect((await client.request("GET", "/v2/memories")).status).toBe(404);
    expect((await client.request("POST", "/v2/search", { query: "anything" })).status).toBe(404);
  });

  it("answers a version it does not serve with a refusal", async () => {
    const { user } = await harness();
    const client = await user("versions");
    expect((await client.request("GET", "/v3/devices")).status).toBe(404);
  });
});
