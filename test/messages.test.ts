import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, type Message, type Sent } from "../src/mailbox";
import { type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

const account = async (h: Harness, userId: string): Promise<{ laptop: Client; desktop: Client }> => {
  const email = await h.invite(`${userId}@example.com`, userId);
  return {
    laptop: h.clientWithToken(await h.login(email, "laptop")),
    desktop: h.clientWithToken(await h.login(email, "desktop")),
  };
};

const deviceId = async (client: Client, name: string): Promise<string> => {
  const response = await client.request("GET", "/v1/devices");
  expect(response.status).toBe(200);
  const listed: { devices: { deviceId: string; name: string }[] } = await response.json();
  const device = listed.devices.find((candidate) => candidate.name === name);
  if (!device) throw new Error(`no device named ${name}`);
  return device.deviceId;
};

const send = (
  client: Client,
  toDeviceId: string,
  body: string,
  toSessionId = "",
  fromSessionId = "",
): Promise<Response> => client.request("POST", "/v1/messages", { toDeviceId, toSessionId, fromSessionId, body });

const sentMessage = async (response: Response): Promise<Message> => (await sentBody(response)).message;

const sentBody = async (response: Response): Promise<Sent> => {
  expect(response.status).toBe(201);
  return await response.json();
};

describe("messages", () => {
  it("names its sender by the label the host carries and the handle of the session that sent it", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const email = await h.invite(`${userId}@example.com`, userId);
    const laptop = h.clientWithToken(await h.login(email, "ip-10-0-7-31"));
    await h.login(email, "desktop");
    const desktopId = await deviceId(laptop, "desktop");
    await env.DB.prepare("INSERT INTO labels (user_id, kind, value, label) VALUES (?, 'host', ?, ?)")
      .bind(userId, "ip-10-0-7-31", "core")
      .run();
    expect((await laptop.sync("9f8a1b2c")).status).toBe(204);

    const named = await sentMessage(await send(laptop, desktopId, "ship it", "", "9f8a1b2c"));
    expect(named).toMatchObject({ fromHost: "core", fromName: "ip-10-0-7-31-9f8a" });

    const hostOnly = await sentMessage(await send(laptop, desktopId, "ship it"));
    expect(hostOnly).toMatchObject({ fromHost: "core", fromName: "" });

    const stale = await sentMessage(await send(laptop, desktopId, "ship it", "", "deadbeef"));
    expect(stale).toMatchObject({ fromHost: "core", fromName: "" });
  });

  // News is published to whoever is attached and the bus owes nothing more, so a send with nobody
  // listening is still a fanout: the message expires unread rather than waiting for a session.
  it("names the target and the sender on a send, and publishes it whoever is listening", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop } = await account(h, userId);
    const laptopId = await deviceId(laptop, "laptop");
    const desktopId = await deviceId(laptop, "desktop");

    const sent = await sentBody(await send(laptop, desktopId, "the release is green"));

    expect(sent.message).toMatchObject({
      toDeviceId: desktopId,
      toSessionId: "",
      fromDeviceId: laptopId,
      body: "the release is green",
    });
    expect(sent.outcome).toEqual({ state: "fanout" });
  });

  it("sends to the one session named, and only on that session's own device", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop, desktop } = await account(h, userId);
    const laptopId = await deviceId(laptop, "laptop");
    const desktopId = await deviceId(laptop, "desktop");
    expect((await desktop.sync("9f8a1b2c")).status).toBe(204);

    const message = await sentMessage(await send(laptop, desktopId, "only you", "9f8a1b2c"));
    expect(message).toMatchObject({ toDeviceId: desktopId, toSessionId: "9f8a1b2c" });

    expect((await send(laptop, laptopId, "the wrong host", "9f8a1b2c")).status).toBe(404);
    expect((await send(laptop, desktopId, "a session that ended", "gone")).status).toBe(404);
    expect((await send(laptop, desktopId, "malformed", "two words")).status).toBe(400);
  });

  it("refuses a body the bus will not carry", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop } = await account(h, userId);
    const desktopId = await deviceId(laptop, "desktop");

    expect((await send(laptop, desktopId, "x".repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
    expect((await send(laptop, desktopId, "x".repeat(MAX_BODY_BYTES))).status).toBe(201);
  });

  it("sends only for an authenticated caller to a device on that caller's own account", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop } = await account(h, userId);
    const desktopId = await deviceId(laptop, "desktop");
    const bob = await h.user("bob");

    expect((await h.send("/v1/messages", { method: "POST" })).status).toBe(401);
    expect((await h.clientWithHeaders({ authorization: "Bearer nope" }).request("POST", "/v1/messages")).status).toBe(
      401,
    );
    expect((await send(bob, desktopId, "wrong account")).status).toBe(404);

    expect((await laptop.request("POST", "/v1/messages", { toDeviceId: desktopId })).status).toBe(400);
    expect((await laptop.request("GET", "/v1/messages")).status).toBe(405);
    expect((await laptop.request("DELETE", `/v1/messages/${crypto.randomUUID()}`)).status).toBe(404);
  });
});
