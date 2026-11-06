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
  ORDERS,
  ORDERS_HEADER,
  type SendInput,
  type Sent,
  TAKER_WINDOW_MS,
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

// The rows a device has, read past everything the mailbox decides, so a test can tell a row that
// is still there from one a read declined to hand over.
const rowIds = (userId: string, toDeviceId: string): Promise<string[]> =>
  runInDurableObject(mailboxOf(userId), (_mailbox: Mailbox, state: DurableObjectState) =>
    state.storage.sql
      .exec<{ message_id: string }>("SELECT message_id FROM messages WHERE to_device_id = ?", toDeviceId)
      .toArray()
      .map((row) => row.message_id),
  );

// An order as the three day queue left it: sent two days ago, and carrying an expiry that is still
// a day out.
const leaveStaleOrder = async (userId: string, toDeviceId: string, now: number): Promise<string> => {
  const messageId = crypto.randomUUID();
  const day = 86_400_000;
  await runInDurableObject(mailboxOf(userId), (_mailbox: Mailbox, state: DurableObjectState) => {
    state.storage.sql.exec(
      `INSERT INTO messages
         (message_id, kind, to_device_id, to_session_id, from_device_id, from_host, from_name, body, created_at, expires_at)
         VALUES (?, 'order', ?, '', 'd-sender', 'laptop', '', 'rerun the migration', ?, ?)`,
      messageId,
      toDeviceId,
      now - 2 * day,
      now + day,
    );
  });
  return messageId;
};

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
// whose chosen session died does. `declares` is whether the upgrade says this daemon reads the kind
// of a message, which a daemon from before orders does not.
const listen = async (h: Harness, token: string, takes: string, declares = true): Promise<Listener> => {
  const response = await h.send("/v1/messages/listen", {
    headers: {
      authorization: `Bearer ${token}`,
      upgrade: "websocket",
      ...(declares ? { [ORDERS_HEADER]: ORDERS } : {}),
    },
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

const outcome = async (response: Response): Promise<Sent> => {
  expect(response.status).toBe(201);
  return await response.json();
};

const sendNow = (userId: string, input: SendInput, now: number): Promise<Sent | null> =>
  runInDurableObject(mailboxOf(userId), (mailbox: Mailbox) =>
    mailbox.enqueue(input, { deviceId: "d-sender", host: "laptop", name: "" }, now),
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

  it("drops an order its listening host never answered for, so the failure the sender reports is true", {
    timeout: 4 * TAKER_WINDOW_MS,
  }, async () => {
    const { h, userId, desktopToken, desktopId } = await bus();
    const holder = await listen(h, desktopToken, "");

    const sent = await sendNow(
      userId,
      { kind: "order", toDeviceId: desktopId, toSessionId: "", fromSessionId: "", body: "rerun the migration" },
      h.now(),
    );

    if (sent === null) throw new Error("the mailbox refused the order it had room for");
    expect(sent.outcome).toEqual({ state: "untaken", reason: NOT_TAKEN });
    await eventually(() => holder.received.length === 1, "the order reaching the host that says nothing");
    expect(await queued(userId, desktopId, h.now())).toEqual([]);
  });

  it("hands no order to a daemon too old to read a kind, and says nobody is listening", async () => {
    const { h, userId, laptop, desktopToken, desktopId } = await bus();
    const first = await outcome(await order(laptop, desktopId, "rerun the migration"));
    expect(first.outcome).toEqual({ state: "untaken", reason: NOTHING_LISTENING });

    const old = await listen(h, desktopToken, "", false);
    const news = await outcome(
      await laptop.request("POST", "/v1/messages", { toDeviceId: desktopId, body: "the build is green" }),
    );
    await eventually(() => old.received.length === 1, "the news an old daemon still reads");
    const second = await outcome(await order(laptop, desktopId, "restart the worker"));

    expect(second.outcome).toEqual({ state: "untaken", reason: NOTHING_LISTENING });
    expect(ids(old.received)).toEqual([news.message.messageId]);
    expect(ids(await queued(userId, desktopId, h.now())).sort()).toEqual(
      ids([first.message, news.message, second.message]).sort(),
    );
  });

  it("hands a backlog one order at a time, the next on the receipt for the last", async () => {
    const { h, userId, laptop, desktopToken, desktopId } = await bus();
    const first = await outcome(await order(laptop, desktopId, "rerun the migration"));
    const second = await outcome(await order(laptop, desktopId, "restart the worker"));

    const holder = await listen(h, desktopToken, "");
    await eventually(() => holder.received.length === 1, "the drain handing one order");
    expect(ids(holder.received)).toEqual([first.message.messageId]);

    ack(holder, first.message.messageId);

    await eventually(() => holder.received.length === 2, "the second order on the receipt for the first");
    expect(ids(holder.received)).toEqual([first.message.messageId, second.message.messageId]);
    expect(ids(await queued(userId, desktopId, h.now()))).toEqual([second.message.messageId]);
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

  // The sweep is the only thing that closes the socket of a revoked device, so a mailbox busy
  // enough to reschedule its alarm on every send must not keep pushing that pass out of reach.
  it("keeps the sweep due where the last one left it, however much traffic arrives", async () => {
    const { laptop, userId, desktopId } = await bus();
    await outcome(await order(laptop, desktopId, "rerun the migration"));
    const due = await alarmAt(userId);
    if (due === null) throw new Error("a mailbox holding an order owes an alarm");

    for (const body of ["the build is green", "the deploy is out", "main is red"]) {
      expect((await laptop.request("POST", "/v1/messages", { toDeviceId: desktopId, body })).status).toBe(201);
      expect(await alarmAt(userId)).toBe(due);
    }
  });

  // Every read decides the TTL for itself, which is what makes the backlog of a three day queue go
  // away rather than keep landing: the row's own expiry is still a day out and counts for nothing.
  // A receipt is the read with no delete in front of it, so it is where that has to hold.
  it("hands nothing past the TTL on a receipt, whatever expiry the queued row carries", async () => {
    const { h, userId, laptop, desktopToken, desktopId } = await bus();
    const holder = await listen(h, desktopToken, "");
    const news = await outcome(
      await laptop.request("POST", "/v1/messages", { toDeviceId: desktopId, body: "the build is green" }),
    );
    await eventually(() => holder.received.length === 1, "the news reaching the host");
    const stale = await leaveStaleOrder(userId, desktopId, h.now());

    ack(holder, news.message.messageId);

    await eventually(async () => (await rowIds(userId, desktopId)).join() === stale, "the receipt for the news");
    expect(ids(holder.received)).toEqual([news.message.messageId]);
    expect(await queued(userId, desktopId, h.now())).toEqual([]);
    expect(await rowIds(userId, desktopId)).toEqual([]);
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
