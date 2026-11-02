import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type Delivery,
  MAX_BODY_BYTES,
  MAX_QUEUED_MESSAGES,
  type Mailbox,
  MESSAGE_TTL_MS,
  type Message,
} from "../src/mailbox";
import type { Session } from "../src/model";
import { type Client, harness, sessionDocument } from "./harness";

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

const queued = (userId: string, toDeviceId: string, now: number): Promise<Message[]> =>
  runInDurableObject(mailboxOf(userId), (mailbox: Mailbox) => mailbox.list(toDeviceId, now));

const send = (client: Client, toDeviceId: string, body: string, delivery?: unknown): Promise<Response> =>
  client.request(
    "POST",
    "/v1/messages",
    delivery === undefined ? { toDeviceId, body } : { toDeviceId, delivery, body },
  );

const sync = (client: Client, sessionId: string, host: string): Promise<Response> =>
  client.request("PUT", `/v1/sessions/${sessionId}`, sessionDocument({ host }));

const sessions = async (client: Client): Promise<Session[]> => {
  const response = await client.request("GET", "/v1/sessions");
  expect(response.status).toBe(200);
  const body: { sessions: Session[] } = await response.json();
  return body.sessions;
};

const sentMessage = async (response: Response): Promise<Message> => {
  expect(response.status).toBe(201);
  const body: { message: Message } = await response.json();
  return body.message;
};

describe("messages", () => {
  it("queues a sent message against the target device only, until that device acks it", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop } = await account(h, userId);
    const laptopId = await deviceId(laptop, "laptop");
    const desktopId = await deviceId(laptop, "desktop");

    const message = await sentMessage(await send(laptop, desktopId, "the release is green"));
    expect(message).toMatchObject({
      toDeviceId: desktopId,
      delivery: { to: "host" },
      fromDeviceId: laptopId,
      body: "the release is green",
    });
    expect(message.expiresAt).toBe(message.createdAt + MESSAGE_TTL_MS);

    expect(await queued(userId, desktopId, h.now())).toEqual([message]);
    expect(await queued(userId, laptopId, h.now())).toEqual([]);
  });

  it("queues a message for the one session a handle names, resolved from another host's listing", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop, desktop } = await account(h, userId);
    const laptopId = await deviceId(laptop, "laptop");
    const desktopId = await deviceId(laptop, "desktop");

    expect((await sync(desktop, "9f8a1b", "desktop")).status).toBe(204);
    expect((await sync(desktop, "9f8c2d", "desktop")).status).toBe(204);

    const listed = await sessions(laptop);
    expect(listed.map((session) => session.name).sort()).toEqual(["desktop-9f", "desktop-9f8"]);
    const target = listed.find((session) => session.name === "desktop-9f");
    if (!target) throw new Error("the listing carries no handle for the session");
    expect(target.deviceId).toBe(desktopId);

    const delivery: Delivery = { to: "session", sessionId: target.sessionId };
    const message = await sentMessage(await send(laptop, target.deviceId, "only you", delivery));
    expect(message).toMatchObject({ toDeviceId: desktopId, delivery });
    expect(await queued(userId, desktopId, h.now())).toEqual([message]);

    expect((await send(laptop, laptopId, "the wrong host", delivery)).status).toBe(404);
    expect((await send(laptop, desktopId, "a session that ended", { to: "session", sessionId: "gone" })).status).toBe(
      404,
    );
    expect((await send(laptop, desktopId, "malformed", { to: "everyone" })).status).toBe(400);
    expect((await send(laptop, desktopId, "malformed", { to: "session" })).status).toBe(400);
    expect((await send(laptop, desktopId, "malformed", { to: "session", sessionId: "two words" })).status).toBe(400);
    expect(await queued(userId, laptopId, h.now())).toEqual([]);
  });

  it("refuses an oversized body, caps the queue per account and expires messages after the TTL", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop } = await account(h, userId);
    const desktopId = await deviceId(laptop, "desktop");

    expect((await send(laptop, desktopId, "x".repeat(MAX_BODY_BYTES + 1))).status).toBe(413);

    await runInDurableObject(mailboxOf(userId), async (mailbox: Mailbox) => {
      for (let index = 0; index < MAX_QUEUED_MESSAGES; index += 1) {
        await mailbox.enqueue(
          { toDeviceId: desktopId, delivery: { to: "host" }, body: `queued ${index}` },
          { userId, deviceId: desktopId },
          h.now(),
        );
      }
    });
    expect((await send(laptop, desktopId, "one too many")).status).toBe(429);

    h.tick(MESSAGE_TTL_MS);
    expect(await queued(userId, desktopId, h.now())).toEqual([]);
    expect((await send(laptop, desktopId, "room again")).status).toBe(201);
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
    expect(await queued(userId, desktopId, h.now())).toEqual([]);

    expect((await laptop.request("POST", "/v1/messages", { toDeviceId: desktopId })).status).toBe(400);
    expect((await laptop.request("GET", "/v1/messages")).status).toBe(405);
    expect((await laptop.request("DELETE", `/v1/messages/${crypto.randomUUID()}`)).status).toBe(404);
  });
});
