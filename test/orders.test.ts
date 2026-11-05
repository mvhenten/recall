import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  LEASE_MS,
  type Mailbox,
  type Message,
  type MessageFrame,
  NO_SESSION_TOOK_IT,
  NOT_TAKEN_YET,
  NOTHING_LISTENING,
  type Outcome,
  type Queued,
  type SendInput,
} from "../src/mailbox";
import { type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

interface Listener {
  socket: WebSocket;
  received: Message[];
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

// A lease is written on the clock the send runs on and read by the alarm, which has only the wall
// clock to read, so the two have to start out agreed: a lease stamped on the harness clock alone
// reads as years overdue and the first alarm retires the order under the test.
const bus = async () => {
  const h = await harness();
  h.tick(Date.now() - h.now());
  const userId = `user-${crypto.randomUUID()}`;
  const email = await h.invite(`${userId}@example.com`, userId);
  const laptop = h.clientWithToken(await h.login(email, "laptop"));
  const desktopToken = await h.login(email, "desktop");
  return {
    h,
    userId,
    laptop,
    desktopToken,
    desktopId: await deviceId(laptop, "desktop"),
  };
};

// `takes` is the session the listener reports, standing in for the daemon picking one of its own
// sessions; a listener that takes nothing leaves the order under its lease, which is what a host
// whose chosen session died does.
const listen = async (h: Harness, token: string, takes: string): Promise<Listener> => {
  const response = await h.send("/v1/messages/listen", {
    headers: { authorization: `Bearer ${token}`, upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("the listen upgrade carried no socket");
  socket.accept();
  const listener: Listener = { socket, received: [] };
  socket.addEventListener("message", (event) => {
    const frame: MessageFrame = JSON.parse(String(event.data));
    listener.received.push(frame.message);
    if (takes === "") return;
    socket.send(JSON.stringify({ type: "took", messageId: frame.message.messageId, sessionId: takes }));
  });
  return listener;
};

const order = (client: Client, toDeviceId: string, body: string): Promise<Response> =>
  client.request("POST", "/v1/messages", { kind: "order", toDeviceId, body });

const outcome = async (response: Response): Promise<{ message: Message; outcome: Outcome }> => {
  expect(response.status).toBe(201);
  return await response.json();
};

const sendNow = (userId: string, input: SendInput, now: number, window: number): Promise<Queued> =>
  runInDurableObject(mailboxOf(userId), (mailbox: Mailbox) =>
    mailbox.enqueue(input, { deviceId: "d-sender", host: "laptop", name: "" }, now, window),
  );

const eventually = async (ready: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await ready()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} never happened`);
};

describe("orders", () => {
  it("hands one order to one listener and tells the sender which session took it", async () => {
    const { h, userId, laptop, desktopToken, desktopId } = await bus();
    const first = await listen(h, desktopToken, "desktop-aaaa");
    const second = await listen(h, desktopToken, "desktop-bbbb");

    const sent = await outcome(await order(laptop, desktopId, "rerun the migration"));

    expect(sent.message.kind).toBe("order");
    expect(sent.outcome).toEqual({
      state: "taken",
      sessionId: first.received.length === 1 ? "desktop-aaaa" : "desktop-bbbb",
    });
    expect(first.received.length + second.received.length).toBe(1);
    await eventually(async () => (await queued(userId, desktopId, h.now())).length === 0, "the order being released");
  });

  it("tells the sender loudly when the host is not listening at all, and keeps the order queued", async () => {
    const { h, userId, laptop, desktopId } = await bus();

    const sent = await outcome(await order(laptop, desktopId, "rerun the migration"));

    expect(sent.outcome).toEqual({ state: "untaken", reason: NOTHING_LISTENING });
    expect(await queued(userId, desktopId, h.now())).toEqual([sent.message]);
  });

  it("tells the sender when the host took the order back because no session could act on it", async () => {
    const { h, userId, laptop, desktopToken, desktopId } = await bus();
    const desktop = await listen(h, desktopToken, "");
    desktop.socket.addEventListener("message", (event) => {
      const frame: MessageFrame = JSON.parse(String(event.data));
      desktop.socket.send(JSON.stringify({ type: "ack", messageId: frame.message.messageId }));
    });

    const sent = await outcome(await order(laptop, desktopId, "rerun the migration"));

    expect(sent.outcome).toEqual({ state: "untaken", reason: NO_SESSION_TOOK_IT });
    expect(await queued(userId, desktopId, h.now())).toEqual([]);
  });

  // The lease is what keeps a second listener, and the same listener reconnecting, from running an
  // order a session already holds. Nothing releases it but the receipt or its own expiry.
  it("hides an order under its lease and offers it again once the lease has run out", async () => {
    const { h, userId, laptop, desktopToken, desktopId } = await bus();
    const holder = await listen(h, desktopToken, "");
    const input: SendInput = {
      kind: "order",
      toDeviceId: desktopId,
      toSessionId: "",
      fromSessionId: "",
      body: "rerun the migration",
    };

    const sent = await sendNow(userId, input, h.now(), 0);
    if (!sent.queued) throw new Error("the mailbox refused the order it had room for");
    expect(sent.outcome).toEqual({ state: "untaken", reason: NOT_TAKEN_YET });
    await eventually(() => holder.received.length === 1, "the order reaching the listener holding it");

    const passedOver = await listen(h, desktopToken, "");
    expect(passedOver.received).toEqual([]);
    expect(await queued(userId, desktopId, h.now())).toEqual([sent.message]);

    h.tick(LEASE_MS + 1);
    const next = await listen(h, desktopToken, "desktop-cccc");
    await eventually(() => next.received.length === 1, "the order being offered again");
    expect(next.received[0]?.messageId).toBe(sent.message.messageId);
    await eventually(async () => (await queued(userId, desktopId, h.now())).length === 0, "the order being released");
    expect(passedOver.received).toEqual([]);

    // Keeping the news side honest: it goes to every socket at once and no lease touches it.
    expect(
      (await laptop.request("POST", "/v1/messages", { toDeviceId: desktopId, body: "the build is green" })).status,
    ).toBe(201);
    await eventually(
      () => holder.received.length === 2 && passedOver.received.length === 1 && next.received.length === 2,
      "the news reaching every socket",
    );
  });

  // The session that took the order dies before it acts on it, so the host reports nothing. The
  // order must outlive it: the lease expiring is the event that offers it to a session again.
  it("offers an order again when the host that took it never reported on it", async () => {
    const { h, userId, desktopToken, desktopId } = await bus();
    const desktop = await listen(h, desktopToken, "");
    const stale = Date.now() - LEASE_MS - 1;

    const sent = await sendNow(
      userId,
      { kind: "order", toDeviceId: desktopId, toSessionId: "", fromSessionId: "", body: "rerun the migration" },
      stale,
      0,
    );
    if (!sent.queued) throw new Error("the mailbox refused the order it had room for");
    await eventually(() => desktop.received.length >= 1, "the first offer");

    await runDurableObjectAlarm(mailboxOf(userId));

    await eventually(() => desktop.received.length >= 2, "the order being offered again");
    expect(new Set(desktop.received.map((message) => message.messageId))).toEqual(new Set([sent.message.messageId]));
    expect(await queued(userId, desktopId, h.now())).toEqual([sent.message]);
  });
});
