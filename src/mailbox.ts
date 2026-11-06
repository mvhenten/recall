import { DurableObject } from "cloudflare:workers";
import { listDevices } from "./device";
import { type Parsed, parseSessionId } from "./model";

// A message is a ping that is relevant now. It goes to the sockets attached when it is sent and to
// nothing else: the bus is not a board a session reads at boot, so one that was not listening then
// never sees it. Nothing is stored anywhere, and the only thing a send ever waits on is the one
// session that takes an order, which lives in this isolate until its host names it.
export const MAX_BODY_BYTES = 32_768;
export const SWEEP_INTERVAL_MS = 900_000;

// How long a send waits for the host to name the session that took an order: a host that is
// listening and has said nothing by then loses the order, since a sender told the order failed
// must not leave one behind for a session to run later.
export const TAKER_WINDOW_MS = 10_000;

export const DEVICE_HEADER = "x-recall-device-id";

// What the daemon declares on the upgrade: it reads a message's kind, so an order written into one
// of its sessions stays with that one. A socket that declares nothing predates orders and would
// fan one out to every session there, so the mailbox hands its orders back.
export const ORDERS_HEADER = "x-recall-orders";
export const ORDERS = "1";

export const CLOSE_BAD_FRAME = 4000;
export const CLOSE_REVOKED = 4001;

export const NOTHING_LISTENING =
  "no host is listening as that device, so nothing can take the order; the bus holds nothing for one that attaches later";
export const NOT_TAKEN = "the host is listening but no session took the order, so it was dropped";
export const NO_SESSION_TOOK_IT = "the host took the order back: it has no session that can act on it";

// News reaches every session the host has registered; an order reaches one of them. The sender
// names which by the verb it used, and the kind never changes after the message is sent.
export type MessageKind = "news" | "order";

// `toSessionId` is the one session the message is addressed to, or empty for every session the
// host has registered. `fromHost` and `fromName` are what the receiver prints over the body, so a
// session reading a message knows who sent it and what to answer; both are resolved at send time
// and ride with the message, leaving the receiver nothing to look up.
export interface Message {
  messageId: string;
  kind: MessageKind;
  toDeviceId: string;
  toSessionId: string;
  fromDeviceId: string;
  fromHost: string;
  fromName: string;
  body: string;
  createdAt: number;
}

export interface Sender {
  deviceId: string;
  host: string;
  name: string;
}

export interface SendInput {
  kind: MessageKind;
  toDeviceId: string;
  toSessionId: string;
  fromSessionId: string;
  body: string;
}

// What the send tells its sender. News is published to whoever is attached and that is the whole
// of the bus's obligation, so a fanout carries nothing. An order names the session that took it,
// and `reason` is what the sender prints when none did.
export type Outcome =
  | { state: "fanout" }
  | { state: "taken"; sessionId: string }
  | { state: "untaken"; reason: string };

// What a send becomes: the message as it went out, and what became of it.
export interface Sent {
  message: Message;
  outcome: Outcome;
}

// `token` is the claim this frame hands the socket, which the receipt has to quote. Only an order
// carries one, since news answers nothing; a news frame carries it empty.
export interface MessageFrame {
  type: "message";
  message: Message;
  token: string;
}

export interface TookFrame {
  type: "took";
  messageId: string;
  sessionId: string;
  token: string;
}

export interface NoTakerFrame {
  type: "none";
  messageId: string;
  token: string;
}

// What a host says about an order: the session that took it, or that it has none that could. News
// is never answered, so these are the only frames a socket ever writes back. A host that writes
// neither leaves the send to give up when its window closes.
export type Receipt = TookFrame | NoTakerFrame;

const RECEIPT_SHAPE =
  '{"type":"took","messageId":"<id>","sessionId":"<id>","token":"<token>"} or {"type":"none","messageId":"<id>","token":"<token>"}';

export interface MailboxEnv {
  DB: D1Database;
}

// `orders` is what the socket declared on the upgrade: whether the daemon behind it reads the kind
// of a message. A socket attached before the mailbox asked declares nothing and gets no order.
interface Attachment {
  deviceId: string;
  orders: boolean;
}

// The one order a send is waiting on: the claim it went out under, which the receipt has to quote,
// and the send to resolve. The map lives in the same isolate as the send, which is the whole of
// the mailbox's in-flight state.
interface Pending {
  token: string;
  resolve: (outcome: Outcome) => void;
  lapse: ReturnType<typeof setTimeout>;
}

const parseToSessionId = (value: unknown): Parsed<string> => {
  if (value === undefined || value === "") return { ok: true, value: "" };
  if (typeof value !== "string") {
    return { ok: false, error: "toSessionId must be a session id, or empty for every session on the host" };
  }
  return parseSessionId(value);
};

const parseFromSessionId = (value: unknown): Parsed<string> => {
  if (value === undefined || value === "") return { ok: true, value: "" };
  if (typeof value !== "string") {
    return { ok: false, error: "fromSessionId must be the id of a session on the sending host" };
  }
  return parseSessionId(value);
};

// A sender too old to name a kind is sending news.
const parseKind = (value: unknown): Parsed<MessageKind> => {
  if (value === undefined || value === "news") return { ok: true, value: "news" };
  if (value === "order") return { ok: true, value: "order" };
  return { ok: false, error: 'kind must be "news" for every session on the host, or "order" for one of them' };
};

export const parseSend = (input: unknown): Parsed<SendInput> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const { kind, toDeviceId, toSessionId, fromSessionId, body } = input as Record<string, unknown>;
  if (typeof toDeviceId !== "string" || toDeviceId.length < 1) {
    return { ok: false, error: "toDeviceId must be the id of a device on this account; see GET /v1/devices" };
  }
  if (typeof body !== "string" || body.length < 1) return { ok: false, error: "body must hold at least one character" };
  const wanted = parseKind(kind);
  if (!wanted.ok) return wanted;
  const session = parseToSessionId(toSessionId);
  if (!session.ok) return session;
  const from = parseFromSessionId(fromSessionId);
  if (!from.ok) return from;
  return {
    ok: true,
    value: {
      kind: wanted.value,
      toDeviceId,
      toSessionId: session.value,
      fromSessionId: from.value,
      body,
    },
  };
};

const readJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const parseReceipt = (raw: string): Receipt | null => {
  const frame = readJson(raw);
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return null;
  const { type, messageId, sessionId, token } = frame as Record<string, unknown>;
  if (typeof messageId !== "string" || messageId.length < 1) return null;
  if (typeof token !== "string" || token.length < 1) return null;
  if (type === "none") return { type: "none", messageId, token };
  if (type !== "took" || typeof sessionId !== "string") return null;
  const took = parseSessionId(sessionId);
  if (!took.ok) return null;
  return { type: "took", messageId, sessionId: took.value, token };
};

const attached = (socket: WebSocket): Attachment | null => {
  const stored: unknown = socket.deserializeAttachment();
  if (typeof stored !== "object" || stored === null) return null;
  const { deviceId, orders } = stored as Record<string, unknown>;
  if (typeof deviceId !== "string") return null;
  return { deviceId, orders: orders === true };
};

const deviceOf = (socket: WebSocket): string | null => attached(socket)?.deviceId ?? null;

const messageFrame = (message: Message, token: string): string =>
  JSON.stringify({ type: "message", message, token } satisfies MessageFrame);

// A socket Cloudflare has not reaped yet is still handed back by `getWebSockets`, and an order
// sent to it reaches nobody, so the caller tries the next socket the device has open.
const deliver = (socket: WebSocket, frame: string): boolean => {
  if (socket.readyState !== WebSocket.READY_STATE_OPEN) return false;
  try {
    socket.send(frame);
    return true;
  } catch {
    return false;
  }
};

// Where the mailbox last made its quarter-hourly pass.
export const SWEPT_AT = "sweptAt";

export class Mailbox extends DurableObject<MailboxEnv> {
  private readonly waiting = new Map<string, Pending>();

  async fetch(request: Request): Promise<Response> {
    const deviceId = request.headers.get(DEVICE_HEADER) ?? "";
    if (deviceId === "") return new Response("the mailbox only answers the listen upgrade", { status: 400 });
    const orders = request.headers.get(ORDERS_HEADER) === ORDERS;
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ deviceId, orders } satisfies Attachment);
    // A socket attaching is handed nothing. A message is a ping that was relevant when it was
    // sent, and this socket was not there for it.
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, received: string | ArrayBuffer): Promise<void> {
    const receipt = typeof received === "string" ? parseReceipt(received) : null;
    if (deviceOf(socket) === null || receipt === null) {
      socket.close(CLOSE_BAD_FRAME, `every frame must be ${RECEIPT_SHAPE}`);
      return;
    }
    this.settle(receipt);
  }

  async alarm(): Promise<void> {
    await this.sweep(Date.now());
    await this.scheduleAlarm();
  }

  async enqueue(input: SendInput, from: Sender, now: number): Promise<Sent> {
    const message: Message = {
      messageId: crypto.randomUUID(),
      kind: input.kind,
      toDeviceId: input.toDeviceId,
      toSessionId: input.toSessionId,
      fromDeviceId: from.deviceId,
      fromHost: from.host,
      fromName: from.name,
      body: input.body,
      createdAt: now,
    };
    return { message, outcome: await this.place(message) };
  }

  // News is published to whoever is attached and nothing is waited on: the push is the whole of
  // the bus's obligation, and a host that was not listening has nothing kept for it. An order goes
  // to one socket, and the sender waits for the receipt naming the session that ran it.
  private async place(message: Message): Promise<Outcome> {
    if (message.kind === "news") {
      this.broadcast(message);
      return { state: "fanout" };
    }
    const token = this.hand(message);
    if (token === null) return { state: "untaken", reason: NOTHING_LISTENING };
    return await this.taker(message.messageId, token);
  }

  private broadcast(message: Message): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (deviceOf(socket) === message.toDeviceId) deliver(socket, messageFrame(message, ""));
    }
  }

  // One order to one live socket that declared it reads kinds, under the claim that socket has to
  // quote to settle it. A daemon too old to read a kind would write the order into every session it
  // has, so it is handed none and the sender is told nobody took it.
  private hand(message: Message): string | null {
    for (const socket of this.ctx.getWebSockets()) {
      const to = attached(socket);
      if (to === null || !to.orders || to.deviceId !== message.toDeviceId) continue;
      const token = crypto.randomUUID();
      if (deliver(socket, messageFrame(message, token))) return token;
    }
    return null;
  }

  private taker(messageId: string, token: string): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      const lapse = setTimeout(() => {
        this.waiting.delete(messageId);
        resolve({ state: "untaken", reason: NOT_TAKEN });
      }, TAKER_WINDOW_MS);
      this.waiting.set(messageId, { token, resolve, lapse });
    });
  }

  // A receipt settles the order it names only if it quotes the claim that order went out under, so
  // a daemon quoting an id it has seen before cannot answer for an order it was never handed.
  private settle(receipt: Receipt): void {
    const pending = this.waiting.get(receipt.messageId);
    if (pending === undefined || pending.token !== receipt.token) return;
    clearTimeout(pending.lapse);
    this.waiting.delete(receipt.messageId);
    pending.resolve(
      receipt.type === "took"
        ? { state: "taken", sessionId: receipt.sessionId }
        : { state: "untaken", reason: NO_SESSION_TOOK_IT },
    );
  }

  // The quarter-hourly pass, and the only thing the alarm is for: close the socket of a device
  // that is no longer signed in. A mailbox with nothing attached owes nothing and stops waking up.
  private async sweep(now: number): Promise<void> {
    if (now < (await this.sweepDue())) return;
    await this.ctx.storage.put(SWEPT_AT, now);
    const live = await this.liveDevices();
    for (const socket of this.ctx.getWebSockets()) {
      const deviceId = deviceOf(socket);
      if (deviceId === null || !live.has(deviceId)) {
        socket.close(CLOSE_REVOKED, "this device is no longer signed in; run recall login");
      }
    }
  }

  private async liveDevices(): Promise<Set<string>> {
    const userId = this.ctx.id.name;
    if (userId === undefined) throw new Error("a mailbox is only ever addressed as idFromName(userId)");
    const devices = await listDevices(this.env.DB, userId);
    return new Set(devices.map((device) => device.deviceId));
  }

  private async scheduleAlarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    await this.ctx.storage.setAlarm(await this.sweepDue());
  }

  // When the next quarter-hourly pass falls due. A mailbox that has never made one dates its first
  // from the moment it had anything to wake up for, so arming the alarm never asks for a pass in
  // the past and a host reconnecting cannot keep pushing the next one out of reach.
  private async sweepDue(): Promise<number> {
    const sweptAt = await this.ctx.storage.get<number>(SWEPT_AT);
    if (sweptAt !== undefined) return sweptAt + SWEEP_INTERVAL_MS;
    const now = Date.now();
    await this.ctx.storage.put(SWEPT_AT, now);
    return now + SWEEP_INTERVAL_MS;
  }
}
