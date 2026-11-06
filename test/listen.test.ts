import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CLOSE_REVOKED,
  type Mailbox,
  type Message,
  type MessageFrame,
  ORDERS,
  ORDERS_HEADER,
  type Sent,
  SWEEP_INTERVAL_MS,
  SWEPT_AT,
} from "../src/mailbox";
import { type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

interface Listener {
  socket: WebSocket;
  received: Message[];
  tokens: string[];
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
  const laptop = h.clientWithToken(await h.login(email, "laptop"));
  const desktopToken = await h.login(email, "desktop");
  return {
    userId,
    laptop,
    desktopToken,
    desktopId: await deviceId(laptop, "desktop"),
  };
};

const sent = async (client: Client, toDeviceId: string, body: string): Promise<Sent> => {
  const response = await client.request("POST", "/v1/messages", { toDeviceId, body });
  expect(response.status).toBe(201);
  return await response.json();
};

// News is never answered, so this listener only records what it was handed.
const listen = async (h: Harness, token: string): Promise<Listener> => {
  const response = await h.send("/v1/messages/listen", {
    headers: { authorization: `Bearer ${token}`, upgrade: "websocket", [ORDERS_HEADER]: ORDERS },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("the listen upgrade carried no socket");
  socket.accept();
  const listener: Listener = { socket, received: [], tokens: [], closed: [] };
  socket.addEventListener("message", (event) => {
    const frame: MessageFrame = JSON.parse(String(event.data));
    listener.received.push(frame.message);
    listener.tokens.push(frame.token);
  });
  socket.addEventListener("close", (event) => listener.closed.push(event.code));
  return listener;
};

const eventually = async (ready: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} never happened`);
};

const ids = (messages: Message[]): string[] => messages.map((message) => message.messageId);

describe("messages listen", () => {
  // The bus publishes to whoever is attached and keeps nothing: what is sent reaches the sockets
  // attached at that moment, and a socket that attaches afterwards is handed nothing however
  // recently the message was sent. The second send is what proves it — a socket that was there for
  // one message and not the other holds only the one it was there for.
  it("pushes to the sockets attached when the message was sent and nothing to one that attaches after", async () => {
    const h = await harness();
    const { laptop, desktopToken, desktopId } = await account(h);

    const first = await listen(h, desktopToken);
    const green = await sent(laptop, desktopId, "the build is green");
    expect(green.outcome).toEqual({ state: "fanout" });
    await eventually(() => first.received.length === 1, "the push to the attached socket");

    const second = await listen(h, desktopToken);
    const red = await sent(laptop, desktopId, "main is red");

    expect(red.outcome).toEqual({ state: "fanout" });
    await eventually(() => second.received.length === 1, "the push to the second socket");
    expect(ids(second.received)).toEqual([red.message.messageId]);
    expect(ids(first.received)).toEqual([green.message.messageId, red.message.messageId]);
    // Only an order is answered, so news goes out under no claim for a receipt to quote.
    expect(first.tokens).toEqual(["", ""]);
  });

  // The sweep is the only thing the alarm is for, and the only thing that closes the socket of a
  // device whose login is gone.
  it("closes the socket of a revoked device on its quarter-hourly pass", async () => {
    const h = await harness();
    const { userId, laptop, desktopToken, desktopId } = await account(h);
    const desktop = await listen(h, desktopToken);

    expect((await laptop.request("DELETE", `/v1/devices/${desktopId}`)).status).toBe(204);
    await runInDurableObject(mailboxOf(userId), (_mailbox: Mailbox, state: DurableObjectState) =>
      state.storage.put(SWEPT_AT, Date.now() - SWEEP_INTERVAL_MS - 1),
    );
    expect(await runDurableObjectAlarm(mailboxOf(userId))).toBe(true);

    await eventually(() => desktop.closed.includes(CLOSE_REVOKED), "the revoked socket closing");
  });
});
