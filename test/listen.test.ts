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
  NOTHING_LISTENING,
  ORDERS,
  ORDERS_HEADER,
  type Sent,
  SWEEP_INTERVAL_MS,
  SWEPT_AT,
} from "../src/mailbox";
import { type Client, harness, mailboxRows } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

interface Listener {
  socket: WebSocket;
  received: Message[];
  tokens: Map<string, string>;
  closed: number[];
}

const mailboxOf = (userId: string): DurableObjectStub<Mailbox> => env.MAILBOX.get(env.MAILBOX.idFromName(userId));

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

const sent = async (client: Client, toDeviceId: string, body: string): Promise<Sent> => {
  const response = await client.request("POST", "/v1/messages", { toDeviceId, body });
  expect(response.status).toBe(201);
  return await response.json();
};

const listen = async (h: Harness, token: string): Promise<Listener> => {
  const response = await h.send("/v1/messages/listen", {
    headers: { authorization: `Bearer ${token}`, upgrade: "websocket", [ORDERS_HEADER]: ORDERS },
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

// A row as a delivery that was never acked left it. Nothing writes one on purpose any more, which
// is why only the sweep and the expiry read them.
const plant = async (userId: string, toDeviceId: string, createdAt: number): Promise<string> => {
  const messageId = crypto.randomUUID();
  await runInDurableObject(mailboxOf(userId), (_mailbox: Mailbox, state: DurableObjectState) => {
    state.storage.sql.exec(
      `INSERT INTO messages
         (message_id, kind, to_device_id, to_session_id, from_device_id, from_host, from_name, body, created_at, expires_at)
         VALUES (?, 'news', ?, '', 'd-sender', 'laptop', '', 'nothing acked this', ?, ?)`,
      messageId,
      toDeviceId,
      createdAt,
      createdAt + MESSAGE_TTL_MS,
    );
  });
  return messageId;
};

describe("messages listen", () => {
  // The bus is a ping, not a board: what is sent reaches the sockets attached at that moment, and
  // a socket that attaches afterwards is handed nothing however recently the message was sent.
  it("pushes to the sockets attached when the message was sent and nothing to one that attaches after", async () => {
    const h = await harness();
    const { userId, laptop, desktopToken, desktopId } = await account(h);

    const listening = await listen(h, desktopToken);
    const pushed = await sent(laptop, desktopId, "the build is green");
    await eventually(() => listening.received.length === 1, "the push to the attached socket");
    expect(pushed.outcome).toEqual({ state: "fanout" });

    const later = await listen(h, desktopToken);
    await eventually(async () => (await mailboxRows(userId, desktopId)).length === 1, "the second socket attaching");
    expect(later.received).toEqual([]);

    for (const message of listening.received) ack(listening, message.messageId);
    await eventually(async () => (await mailboxRows(userId, desktopId)).length === 0, "the ack");
  });

  it("tells a sender whose message reached no socket, and keeps nothing for one that attaches later", async () => {
    const h = await harness();
    const { userId, laptop, desktopToken, desktopId } = await account(h);

    const missed = await sent(laptop, desktopId, "nobody is listening for this");

    expect(missed.outcome).toEqual({ state: "untaken", reason: NOTHING_LISTENING });
    expect(await mailboxRows(userId, desktopId)).toEqual([]);

    const late = await listen(h, desktopToken);
    await eventually(async () => (await mailboxRows(userId, desktopId)).length === 0, "the late socket attaching");
    expect(late.received).toEqual([]);
  });

  // Nothing is delivered out of a row, so the only rows left are the ones no receipt released: a
  // push whose host died before it acked, or an order whose holder was evicted. The sweep is what
  // keeps those from piling up, and it is the only thing that closes a revoked device's socket.
  it("sweeps rows nothing acked, rows for a device that is gone and the socket of a revoked device", async () => {
    const h = await harness();
    const { userId, laptop, laptopId, desktopToken, desktopId } = await account(h);
    const now = Date.now();
    const orphanId = crypto.randomUUID();
    const unacked = await plant(userId, laptopId, now - MESSAGE_TTL_MS - 1);
    const inFlight = await plant(userId, laptopId, now);
    await plant(userId, orphanId, now);

    const desktop = await listen(h, desktopToken);
    expect((await laptop.request("DELETE", `/v1/devices/${desktopId}`)).status).toBe(204);
    await runInDurableObject(mailboxOf(userId), (_mailbox: Mailbox, state: DurableObjectState) =>
      state.storage.put(SWEPT_AT, now - SWEEP_INTERVAL_MS - 1),
    );
    expect(await runDurableObjectAlarm(mailboxOf(userId))).toBe(true);

    expect(await mailboxRows(userId, laptopId)).toEqual([inFlight]);
    expect(unacked).not.toBe(inFlight);
    expect(await mailboxRows(userId, orphanId)).toEqual([]);
    await eventually(() => desktop.closed.includes(CLOSE_REVOKED), "the revoked socket closing");
  });
});
