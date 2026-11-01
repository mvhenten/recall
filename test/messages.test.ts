import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, MAX_QUEUED_MESSAGES, type Mailbox, MESSAGE_TTL_MS, type Message } from "../src/mailbox";
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

const inbox = async (client: Client): Promise<Message[]> => {
  const response = await client.request("GET", "/v1/messages");
  expect(response.status).toBe(200);
  const page: { messages: Message[] } = await response.json();
  return page.messages;
};

const send = (client: Client, toDeviceId: string, body: string): Promise<Response> =>
  client.request("POST", "/v1/messages", { toDeviceId, body });

describe("messages", () => {
  it("queues a message for another device on the account, delivers it once and drops it on ack", async () => {
    const h = await harness();
    const { laptop, desktop } = await account(h, `user-${crypto.randomUUID()}`);
    const laptopId = await deviceId(laptop, "laptop");
    const desktopId = await deviceId(laptop, "desktop");

    const sent = await send(laptop, desktopId, "the release is green");
    expect(sent.status).toBe(201);
    const { message }: { message: Message } = await sent.json();
    expect(message).toMatchObject({ toDeviceId: desktopId, fromDeviceId: laptopId, body: "the release is green" });
    expect(message.expiresAt).toBe(message.createdAt + MESSAGE_TTL_MS);

    expect(await inbox(laptop)).toEqual([]);
    expect(await inbox(desktop)).toEqual([message]);

    expect((await laptop.request("DELETE", `/v1/messages/${message.messageId}`)).status).toBe(404);
    expect((await desktop.request("DELETE", `/v1/messages/${message.messageId}`)).status).toBe(204);
    expect(await inbox(desktop)).toEqual([]);
    expect((await desktop.request("DELETE", `/v1/messages/${message.messageId}`)).status).toBe(404);
  });

  it("refuses an oversized body, caps the queue per account and expires messages after the TTL", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop, desktop } = await account(h, userId);
    const desktopId = await deviceId(laptop, "desktop");

    expect((await send(laptop, desktopId, "x".repeat(MAX_BODY_BYTES + 1))).status).toBe(413);

    const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(userId));
    await runInDurableObject(mailbox, (instance: Mailbox) => {
      for (let index = 0; index < MAX_QUEUED_MESSAGES; index += 1) {
        instance.enqueue({ toDeviceId: desktopId, body: `queued ${index}` }, desktopId, h.now());
      }
    });
    expect((await send(laptop, desktopId, "one too many")).status).toBe(429);

    h.tick(MESSAGE_TTL_MS);
    expect(await inbox(desktop)).toEqual([]);
    expect((await send(laptop, desktopId, "room again")).status).toBe(201);
  });

  it("answers only an authenticated caller and never routes to another account's device", async () => {
    const h = await harness();
    const { laptop, desktop } = await account(h, `user-${crypto.randomUUID()}`);
    const desktopId = await deviceId(laptop, "desktop");
    const bob = await h.user("bob");

    expect((await h.send("/v1/messages")).status).toBe(401);
    expect((await h.clientWithHeaders({ authorization: "Bearer nope" }).request("GET", "/v1/messages")).status).toBe(
      401,
    );
    expect((await send(bob, desktopId, "wrong account")).status).toBe(404);
    expect(await inbox(desktop)).toEqual([]);

    expect((await laptop.request("POST", "/v1/messages", { toDeviceId: desktopId })).status).toBe(400);
    expect((await laptop.request("PUT", "/v1/messages", { toDeviceId: desktopId, body: "hi" })).status).toBe(405);
  });
});
