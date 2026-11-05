import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  LEASE_MS,
  type Mailbox,
  type Message,
  type MessageFrame,
  NO_SESSION_TOOK_IT,
  NOT_TAKEN,
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
  tokens: Map<string, string>;
}

const mailboxOf = (userId: string): DurableObjectStub<Mailbox> => env.MAILBOX.get(env.MAILBOX.idFromName(userId));

const queued = (userId: string, toDeviceId: string, now: number): Promise<Message[]> =>
  runInDurableObject(mailboxOf(userId), (mailbox: Mailbox) => mailbox.list(toDeviceId, now));

const alarmAt = (userId: string): Promise<number | null> =>
  runInDurableObject(mailboxOf(userId), (_mailbox: Mailbox, state: DurableObjectState) => state.storage.getAlarm());

const deviceId = async (client: Client, name: string): Promise<string> => {
  const response = await client.request("GET", "/v1/devices");
  expect(response.status).toBe(200);
  const listed: { devices: { deviceId: string; name: string }[] } = await response.json();
  const device = listed.devices.find((candidate) => candidate.name === name);
  if (!device) throw new Error(`no device named ${name}`);
  return device.deviceId;
};

// A lease is written on the clock the send runs on and read by the alarm, which has only the wall
// clock to read, so the two have to agree before the first order goes out: a lease stamped on the
// harness clock alone is either years overdue or never due, and nothing past it can test the
// alarm. Signing a device in advances the harness clock, so the two are squared up last.
const bus = async () => {
  const h = await harness();
  const userId = `user-${crypto.randomUUID()}`;
  const email = await h.invite(`${userId}@example.com`, userId);
  const laptop = h.clientWithToken(await h.login(email, "laptop"));
  const desktopToken = await h.login(email, "desktop");
  const desktopId = await deviceId(laptop, "desktop");
  h.tick(Date.now() - h.now());
  return { h, userId, laptop, desktopToken, desktopId };
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
  const listener: Listener = { socket, received: [], tokens: new Map() };
  socket.addEventListener("message", (event) => {
    const frame: MessageFrame = JSON.parse(String(event.data));
    listener.received.push(frame.message);
    listener.tokens.set(frame.message.messageId, frame.token);
    if (takes === "") return;
    socket.send(
      JSON.stringify({ type: "took", messageId: frame.message.messageId, sessionId: takes, token: frame.token }),
    );
  });
  return listener;
};

const ack = (listener: Listener, messageId: string, token?: string): void => {
  listener.socket.send(
    JSON.stringify({ type: "ack", messageId, token: token ?? listener.tokens.get(messageId) ?? "" }),
  );
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

const ids = (messages: Message[]): string[] => messages.map((message) => message.messageId);

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
      ack(desktop, frame.message.messageId, frame.token);
    });

    const sent = await outcome(await order(laptop, desktopId, "rerun the migration"));

    expect(sent.outcome).toEqual({ state: "untaken", reason: NO_SESSION_TOOK_IT });
    expect(await queued(userId, desktopId, h.now())).toEqual([]);
  });

  it("drops an order its listening host never answered for, so the failure the sender reports is true", async () => {
    const { h, userId, desktopToken, desktopId } = await bus();
    const holder = await listen(h, desktopToken, "");

    const sent = await sendNow(
      userId,
      { kind: "order", toDeviceId: desktopId, toSessionId: "", fromSessionId: "", body: "rerun the migration" },
      h.now(),
      0,
    );

    if (!sent.queued) throw new Error("the mailbox refused the order it had room for");
    expect(sent.outcome).toEqual({ state: "untaken", reason: NOT_TAKEN });
    await eventually(() => holder.received.length === 1, "the order reaching the host that says nothing");
    expect(await queued(userId, desktopId, h.now())).toEqual([]);
  });

  it("hands a backlog one order at a time and offers a lapsed lease again", async () => {
    const { h, userId, laptop, desktopToken, desktopId } = await bus();
    const first = await outcome(await order(laptop, desktopId, "rerun the migration"));
    const second = await outcome(await order(laptop, desktopId, "restart the worker"));

    const holder = await listen(h, desktopToken, "");
    await eventually(() => holder.received.length === 1, "the drain handing one order");
    expect(ids(holder.received)).toEqual([first.message.messageId]);

    const other = await listen(h, desktopToken, "");
    await eventually(() => other.received.length === 1, "the second order going to the second socket");
    expect(ids(other.received)).toEqual([second.message.messageId]);

    h.tick(LEASE_MS + 1);
    const next = await listen(h, desktopToken, "desktop-cccc");
    await eventually(() => next.received.length >= 1, "the lapsed order being offered again");
    expect(next.received[0]?.messageId).toBe(first.message.messageId);
    await eventually(
      async () => !ids(await queued(userId, desktopId, h.now())).includes(first.message.messageId),
      "the order being released by the session that took it",
    );
  });

  it("offers an order again when the host that took it never reported on it", async () => {
    const { h, userId, laptop, desktopToken, desktopId } = await bus();
    const sent = await outcome(await order(laptop, desktopId, "rerun the migration"));

    h.tick(-(LEASE_MS + 1));
    const desktop = await listen(h, desktopToken, "");
    h.tick(LEASE_MS + 1);

    await runDurableObjectAlarm(mailboxOf(userId));

    await eventually(() => desktop.received.length >= 2, "the order being offered again");
    expect(new Set(ids(desktop.received))).toEqual(new Set([sent.message.messageId]));
    expect(await queued(userId, desktopId, h.now())).toEqual([sent.message]);
  });

  it("arms the alarm at the expiry of the lease the drain wrote", async () => {
    const { h, userId, laptop, desktopToken, desktopId } = await bus();
    await outcome(await order(laptop, desktopId, "rerun the migration"));

    const at = h.now();
    await listen(h, desktopToken, "");

    expect(await alarmAt(userId)).toBe(at + LEASE_MS);
  });

  it("refuses a receipt that does not quote the lease the order went out under", async () => {
    const { h, userId, laptop, desktopToken, desktopId } = await bus();
    const sent = await outcome(await order(laptop, desktopId, "rerun the migration"));
    const holder = await listen(h, desktopToken, "");
    await eventually(() => holder.received.length === 1, "the drain handing the order");

    ack(holder, sent.message.messageId, crypto.randomUUID());
    expect(
      (await laptop.request("POST", "/v1/messages", { toDeviceId: desktopId, body: "the build is green" })).status,
    ).toBe(201);
    await eventually(() => holder.received.length === 2, "the news that follows the refused receipt");
    const news = holder.received[1];
    if (!news) throw new Error("the news never arrived");
    ack(holder, news.messageId);

    await eventually(
      async () => ids(await queued(userId, desktopId, h.now())).join() === sent.message.messageId,
      "the news being released while the order is held",
    );
  });
});
