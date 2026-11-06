import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type Mailbox,
  type Message,
  type MessageFrame,
  NO_SESSION_TOOK_IT,
  NOT_TAKEN,
  NOTHING_LISTENING,
  ORDERS,
  ORDERS_HEADER,
  type Receipt,
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

// What a listener writes back about each order it is handed, standing in for the daemon writing it
// into one of its own sessions: the session that took it, that it has none that could, or nothing
// at all, which is what a host whose chosen session wedged does. News is never answered.
type Answer = (frame: MessageFrame) => Receipt | null;

const takenBy =
  (sessionId: string): Answer =>
  (frame) => ({ type: "took", messageId: frame.message.messageId, sessionId, token: frame.token });

const noTaker: Answer = (frame) => ({ type: "none", messageId: frame.message.messageId, token: frame.token });

const saysNothing: Answer = () => null;

const mailboxOf = (userId: string): DurableObjectStub<Mailbox> => env.MAILBOX.get(env.MAILBOX.idFromName(userId));

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

// The mailbox arms its sweep on the wall clock and the harness sends on one of its own, so the two
// have to agree before anything is sent. Signing a device in advances the harness clock, so they
// are squared up last.
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

// `declares` is whether the upgrade says this daemon reads the kind of a message, which a daemon
// from before orders does not.
const listen = async (h: Harness, token: string, answer: Answer, declares = true): Promise<Listener> => {
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
    if (frame.message.kind !== "order") return;
    const reply = answer(frame);
    if (reply !== null) socket.send(JSON.stringify(reply));
  });
  return listener;
};

const order = (client: Client, toDeviceId: string, body: string): Promise<Response> =>
  client.request("POST", "/v1/messages", { kind: "order", toDeviceId, body });

const outcome = async (response: Response): Promise<Sent> => {
  expect(response.status).toBe(201);
  return await response.json();
};

const sendNow = (userId: string, input: SendInput, now: number): Promise<Sent> =>
  runInDurableObject(mailboxOf(userId), (mailbox: Mailbox) =>
    mailbox.enqueue(input, { deviceId: "d-sender", host: "laptop", name: "" }, now),
  );

const eventually = async (ready: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} never happened`);
};

const ids = (messages: Message[]): string[] => messages.map((message) => message.messageId);

describe("orders", () => {
  it("hands one order to one listener and tells the sender which session took it", async () => {
    const { h, laptop, desktopToken, desktopId } = await bus();
    const first = await listen(h, desktopToken, takenBy("desktop-aaaa"));
    const second = await listen(h, desktopToken, takenBy("desktop-bbbb"));

    const sent = await outcome(await order(laptop, desktopId, "rerun the migration"));

    expect(sent.message.kind).toBe("order");
    expect(sent.outcome).toEqual({
      state: "taken",
      sessionId: first.received.length === 1 ? "desktop-aaaa" : "desktop-bbbb",
    });
    expect(first.received.length + second.received.length).toBe(1);
  });

  it("tells the sender loudly when the host is not listening, and keeps nothing for one that attaches later", async () => {
    const { h, laptop, desktopToken, desktopId } = await bus();

    const missed = await outcome(await order(laptop, desktopId, "rerun the migration"));
    expect(missed.outcome).toEqual({ state: "untaken", reason: NOTHING_LISTENING });

    const late = await listen(h, desktopToken, takenBy("desktop-aaaa"));
    const second = await outcome(await order(laptop, desktopId, "restart the worker"));

    expect(second.outcome).toEqual({ state: "taken", sessionId: "desktop-aaaa" });
    expect(ids(late.received)).toEqual([second.message.messageId]);
  });

  it("tells the sender when the host took the order back because no session could act on it", async () => {
    const { h, laptop, desktopToken, desktopId } = await bus();
    const desktop = await listen(h, desktopToken, noTaker);

    const sent = await outcome(await order(laptop, desktopId, "rerun the migration"));

    expect(sent.outcome).toEqual({ state: "untaken", reason: NO_SESSION_TOOK_IT });
    expect(ids(desktop.received)).toEqual([sent.message.messageId]);
  });

  it("drops an order its listening host never answered for, so the failure the sender reports is true", {
    timeout: 4 * TAKER_WINDOW_MS,
  }, async () => {
    const { h, userId, desktopToken, desktopId } = await bus();
    const holder = await listen(h, desktopToken, saysNothing);

    const sent = await sendNow(
      userId,
      { kind: "order", toDeviceId: desktopId, toSessionId: "", fromSessionId: "", body: "rerun the migration" },
      h.now(),
    );

    expect(sent.outcome).toEqual({ state: "untaken", reason: NOT_TAKEN });
    expect(ids(holder.received)).toEqual([sent.message.messageId]);
  });

  it("hands no order to a daemon too old to read a kind, and says nobody is listening", async () => {
    const { h, laptop, desktopToken, desktopId } = await bus();
    const first = await outcome(await order(laptop, desktopId, "rerun the migration"));
    expect(first.outcome).toEqual({ state: "untaken", reason: NOTHING_LISTENING });

    const old = await listen(h, desktopToken, noTaker, false);
    const news = await outcome(
      await laptop.request("POST", "/v1/messages", { toDeviceId: desktopId, body: "the build is green" }),
    );
    await eventually(() => old.received.length === 1, "the news an old daemon still reads");
    const second = await outcome(await order(laptop, desktopId, "restart the worker"));

    expect(second.outcome).toEqual({ state: "untaken", reason: NOTHING_LISTENING });
    expect(ids(old.received)).toEqual([news.message.messageId]);
  });

  // The sweep is the only thing that closes the socket of a revoked device, so a mailbox busy
  // enough to be sending and reconnecting must not keep pushing that pass out of reach.
  it("keeps the sweep due where the last one left it, however much traffic arrives", async () => {
    const { h, laptop, userId, desktopToken, desktopId } = await bus();
    await listen(h, desktopToken, takenBy("desktop-aaaa"));
    const due = await alarmAt(userId);
    if (due === null) throw new Error("a mailbox with a socket attached owes an alarm");

    for (const body of ["the build is green", "the deploy is out", "main is red"]) {
      expect((await laptop.request("POST", "/v1/messages", { toDeviceId: desktopId, body })).status).toBe(201);
      expect(await alarmAt(userId)).toBe(due);
    }

    await listen(h, desktopToken, takenBy("desktop-bbbb"));
    expect(await alarmAt(userId)).toBe(due);
  });

  // The claim is what ties a receipt to the order it answers. Without it a daemon quoting an id it
  // has seen before could settle an order it was never handed, and the sender would be told a
  // session took it that never saw it.
  it("ignores a receipt that does not quote the token the order went out under", {
    timeout: 4 * TAKER_WINDOW_MS,
  }, async () => {
    const { h, laptop, desktopToken, desktopId } = await bus();
    const holder = await listen(h, desktopToken, saysNothing);
    const placing = order(laptop, desktopId, "rerun the migration");
    await eventually(() => holder.received.length === 1, "the order reaching the host");
    const pushed = holder.received[0];
    if (pushed === undefined) throw new Error("the order never arrived");

    const quoting = (token: string): string =>
      JSON.stringify({
        type: "took",
        messageId: pushed.messageId,
        sessionId: "desktop-aaaa",
        token,
      } satisfies Receipt);
    holder.socket.send(quoting(crypto.randomUUID()));
    holder.socket.send(
      JSON.stringify({
        type: "none",
        messageId: pushed.messageId,
        token: holder.tokens.get(pushed.messageId) ?? "",
      } satisfies Receipt),
    );

    expect((await outcome(await placing)).outcome).toEqual({ state: "untaken", reason: NO_SESSION_TOOK_IT });
  });
});
