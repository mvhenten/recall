import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  MAX_QUEUED_MESSAGES,
  type Mailbox,
  MESSAGE_TTL_MS,
  type Message,
  NOTHING_LISTENING,
  type Sent,
} from "../src/mailbox";
import { type Client, harness, mailboxRows } from "./harness";

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

const mailboxOf = (userId: string): DurableObjectStub<Mailbox> => env.MAILBOX.get(env.MAILBOX.idFromName(userId));

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

  it("names the target and the sender on a send, and holds nothing for a device that was not listening", async () => {
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
    expect(sent.message.expiresAt).toBe(sent.message.createdAt + MESSAGE_TTL_MS);
    expect(sent.outcome).toEqual({ state: "untaken", reason: NOTHING_LISTENING });
    expect(await mailboxRows(userId, desktopId)).toEqual([]);
    expect(await mailboxRows(userId, laptopId)).toEqual([]);
  });

  it("queues a message for the one session named, and only on that session's own device", async () => {
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
    expect(await mailboxRows(userId, laptopId)).toEqual([]);
  });

  // A send keeps nothing, so the only rows that pile up are pushes a host took and never acked.
  // The cap is what stops those filling the account, and the TTL is what clears them.
  it("refuses an oversized body, caps the rows per account and clears them after the TTL", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop } = await account(h, userId);
    const desktopId = await deviceId(laptop, "desktop");

    expect((await send(laptop, desktopId, "x".repeat(MAX_BODY_BYTES + 1))).status).toBe(413);

    await runInDurableObject(mailboxOf(userId), (_mailbox: Mailbox, state: DurableObjectState) => {
      for (let index = 0; index < MAX_QUEUED_MESSAGES; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO messages
             (message_id, kind, to_device_id, to_session_id, from_device_id, from_host, from_name, body, created_at, expires_at)
             VALUES (?, 'news', ?, '', 'd-sender', 'laptop', '', ?, ?, ?)`,
          crypto.randomUUID(),
          desktopId,
          `nothing acked ${index}`,
          h.now(),
          h.now() + MESSAGE_TTL_MS,
        );
      }
    });
    expect((await send(laptop, desktopId, "one too many")).status).toBe(429);

    h.tick(MESSAGE_TTL_MS + 1);
    expect((await send(laptop, desktopId, "room again")).status).toBe(201);
    expect(await mailboxRows(userId, desktopId)).toEqual([]);
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
    expect(await mailboxRows(userId, desktopId)).toEqual([]);

    expect((await laptop.request("POST", "/v1/messages", { toDeviceId: desktopId })).status).toBe(400);
    expect((await laptop.request("GET", "/v1/messages")).status).toBe(405);
    expect((await laptop.request("DELETE", `/v1/messages/${crypto.randomUUID()}`)).status).toBe(404);
  });
});
