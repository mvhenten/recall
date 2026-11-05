import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type AckFrame,
  CLOSE_REVOKED,
  type Mailbox,
  MESSAGE_TTL_MS,
  type Message,
  type MessageFrame,
} from "../src/mailbox";
import { type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

interface Listener {
  socket: WebSocket;
  received: Message[];
  tokens: Map<string, string>;
  closed: number[];
}

const mailboxOf = (userId: string): DurableObjectStub<Mailbox> => env.MAILBOX.get(env.MAILBOX.idFromName(userId));

const queued = (userId: string, toDeviceId: string, now: number): Promise<Message[]> =>
  runInDurableObject(mailboxOf(userId), (mailbox: Mailbox) => mailbox.list(toDeviceId, now));

const deviceId = async (client: Client, name: string): Promise<string> => {
  const response = await client.request("GET", "/v1/devices");
  expect(response.status).toBe(200);
  const listed: { devices: { deviceId: string; name: string }[] } = await response.json();
  const device = listed.devices.find((candidate) => candidate.name === name);
  if (!device) throw new Error(`no device named ${name}`);
  return device.deviceId;
};

const account = async (h: Harness) => {
  const userId = `user-${crypto.randomUUID()}`;
  const email = await h.invite(`${userId}@example.com`, userId);
  const laptopToken = await h.login(email, "laptop");
  const desktopToken = await h.login(email, "desktop");
  const laptop = h.clientWithToken(laptopToken);
  return {
    userId,
    laptop,
    desktopToken,
    laptopId: await deviceId(laptop, "laptop"),
    desktopId: await deviceId(laptop, "desktop"),
  };
};

const send = async (client: Client, toDeviceId: string, body: string): Promise<void> => {
  const response = await client.request("POST", "/v1/messages", { toDeviceId, body });
  expect(response.status).toBe(201);
};

const listen = async (h: Harness, token: string): Promise<Listener> => {
  const response = await h.send("/v1/messages/listen", {
    headers: { authorization: `Bearer ${token}`, upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("the listen upgrade carried no socket");
  socket.accept();
  const listener: Listener = { socket, received: [], tokens: new Map(), closed: [] };
  socket.addEventListener("message", (event) => {
    const frame: MessageFrame = JSON.parse(String(event.data));
    listener.received.push(frame.message);
    listener.tokens.set(frame.message.messageId, frame.token);
  });
  socket.addEventListener("close", (event) => listener.closed.push(event.code));
  return listener;
};

const ack = (listener: Listener, messageId: string): void => {
  const token = listener.tokens.get(messageId) ?? "";
  listener.socket.send(JSON.stringify({ type: "ack", messageId, token } satisfies AckFrame));
};

const eventually = async (ready: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await ready()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} never happened`);
};

describe("messages listen", () => {
  it("drains the connecting device's backlog, pushes what follows and drops an acked message", async () => {
    const h = await harness();
    const { userId, laptop, laptopId, desktopToken, desktopId } = await account(h);

    await send(laptop, desktopId, "queued before the socket");
    await send(laptop, laptopId, "addressed to the laptop");

    const desktop = await listen(h, desktopToken);
    await eventually(() => desktop.received.length === 1, "the backlog drain");

    await send(laptop, desktopId, "pushed while connected");
    await eventually(() => desktop.received.length === 2, "the live push");
    expect(desktop.received.map((message) => message.body)).toEqual([
      "queued before the socket",
      "pushed while connected",
    ]);

    for (const message of desktop.received) ack(desktop, message.messageId);
    await eventually(async () => (await queued(userId, desktopId, h.now())).length === 0, "both acks");
    expect(await queued(userId, laptopId, h.now())).toHaveLength(1);
  });

  it("redelivers an unacked message to the next socket and acks the same id once", async () => {
    const h = await harness();
    const { userId, laptop, desktopToken, desktopId } = await account(h);

    await send(laptop, desktopId, "first");
    await send(laptop, desktopId, "second");

    const dropped = await listen(h, desktopToken);
    await eventually(() => dropped.received.length === 2, "the first drain");
    const [first, second] = dropped.received;
    if (!first || !second) throw new Error("the first drain delivered nothing");
    dropped.socket.close();

    const reconnected = await listen(h, desktopToken);
    await eventually(() => reconnected.received.length === 2, "the redelivery");
    expect(reconnected.received.map((message) => message.messageId)).toEqual([first.messageId, second.messageId]);

    ack(reconnected, first.messageId);
    ack(reconnected, first.messageId);
    await eventually(async () => (await queued(userId, desktopId, h.now())).length === 1, "the ack");
    expect((await queued(userId, desktopId, h.now()))[0]?.messageId).toBe(second.messageId);
  });

  it("sweeps expired rows, rows for a device that is gone and the socket of a revoked device", async () => {
    const h = await harness();
    const { userId, laptop, laptopId, desktopToken, desktopId } = await account(h);
    const from = { deviceId: laptopId, host: "laptop", name: "" };
    const now = Date.now();
    const orphanId = crypto.randomUUID();

    const live = await runInDurableObject(mailboxOf(userId), async (mailbox: Mailbox) => {
      await mailbox.enqueue(
        { kind: "news", toDeviceId: laptopId, toSessionId: "", fromSessionId: "", body: "past the TTL" },
        from,
        now - MESSAGE_TTL_MS - 1,
        0,
      );
      await mailbox.enqueue(
        { kind: "news", toDeviceId: orphanId, toSessionId: "", fromSessionId: "", body: "nobody holds this device" },
        from,
        now,
        0,
      );
      return mailbox.enqueue(
        { kind: "news", toDeviceId: laptopId, toSessionId: "", fromSessionId: "", body: "still within the TTL" },
        from,
        now,
        0,
      );
    });
    if (!live.queued) throw new Error("the mailbox refused the message it had room for");

    const desktop = await listen(h, desktopToken);
    expect((await laptop.request("DELETE", `/v1/devices/${desktopId}`)).status).toBe(204);
    expect(await runDurableObjectAlarm(mailboxOf(userId))).toBe(true);

    expect(await queued(userId, laptopId, now)).toEqual([live.message]);
    expect(await queued(userId, orphanId, now)).toEqual([]);
    await eventually(() => desktop.closed.includes(CLOSE_REVOKED), "the revoked socket closing");
  });
});
