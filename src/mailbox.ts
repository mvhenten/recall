import { DurableObject } from "cloudflare:workers";
import { parseSessionId } from "./model";

// A message is a ping that is relevant now. It goes to the sockets attached when it is sent and to
// nothing else: the bus is not a board a session reads at boot, so one that was not listening then
// never sees it. Nothing is stored anywhere, and the only thing a send ever waits on is the one
// session that takes an order, which lives in this isolate until its host names it.
export const MAX_BODY_BYTES = 32_768;

// How long a send waits for the host to name the session that took an order: a host that is
// listening and has said nothing by then loses the order, since a sender told the order failed
// must not leave one behind for a session to run later.
//
// The host's walk over its own sessions is cut to fit inside this window: `ORDER_WALK` in
// cli/src/sessions.rs is this window less the one write timeout the host allows itself, so the
// receipt is written while the send is still waiting. A host that walked past it would have a
// session take an order the sender had already been told nobody took.
export const TAKER_WINDOW_MS = 10_000;

export const DEVICE_HEADER = "x-recall-device-id";

// What the daemon declares on the upgrade: it reads a message's kind, so an order written into one
// of its sessions stays with that one. A socket that declares nothing predates orders and would
// fan one out to every session there, so the mailbox hands its orders back. A peek is handed on
// the same declaration, and a daemon that reads kinds but not peeks ignores the frame.
export const ORDERS_HEADER = "x-recall-orders";
export const ORDERS = "1";

export const CLOSE_REVOKED = 4001;

export const NOTHING_LISTENING =
  "no host is listening as that device, so nothing can take the order; the bus holds nothing for one that attaches later";
export const NOT_TAKEN = "the host is listening but no session took the order, so it was dropped";
export const NO_SESSION_TOOK_IT = "the host took the order back: it has no session that can act on it";

export const NO_PEEK_LISTENING =
  "no host is listening as that device, so nothing can summarise that session; the bus holds nothing for one that attaches later";
export const PEEK_NOT_TAKEN = "the host is listening but never answered the peek, so it was dropped";
export const NOT_SUMMARISED = "the host took the peek back: it is not running that session";

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

// A message on the wire. `expiresAt` is dead weight this release carries: every daemon released
// before it refuses a frame that has no such field, and none of them reads anything out of it. It
// goes once no host is still running one of those.
interface Pushed extends Message {
  expiresAt: number;
}

// News is published and answered with nothing, so its frame carries no claim. An order's does:
// `token` is what the receipt has to quote for the mailbox to settle the send waiting on it.
export interface NewsFrame {
  type: "message";
  message: Pushed;
}

export interface OrderFrame {
  type: "order";
  message: Pushed;
  token: string;
}

// What a host is handed to summarise one of its own sessions. It carries no prose and no sender,
// so it is not a message: the asker wrote the row the digest lands on, and this says which row and
// which session. It goes out the way an order does, to one socket that reads kinds, under a claim
// the receipt has to quote.
export interface PeekOrder {
  peekId: string;
  sessionId: string;
  toDeviceId: string;
  requestedAt: number;
}

export interface PeekFrame {
  type: "peek";
  peek: PeekOrder;
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

// A peek is answered the way an order is, under a word of its own: the kind of thing a receipt
// answers is what it says it is, never which fields it carries. It names no session, because the
// peek named one when it went out.
export interface PeekReceiptFrame {
  type: "peek-took" | "peek-none";
  peekId: string;
  token: string;
}

// What a host says about an order or a peek: the session that took it, or that it has none that
// could. News is never answered, so these are the only frames a socket ever writes back. A host
// that writes neither leaves the send to give up when its window closes.
export type Receipt = TookFrame | NoTakerFrame | PeekReceiptFrame;

// Which of the two a receipt answers, read off the word it leads with and off nothing else.
const peeked = (receipt: Receipt): receipt is PeekReceiptFrame =>
  receipt.type === "peek-took" || receipt.type === "peek-none";

// `orders` is what the socket declared on the upgrade: whether the daemon behind it reads the kind
// of a message. A socket attached before the mailbox asked declares nothing and gets no order.
interface Attachment {
  deviceId: string;
  orders: boolean;
}

// The one order or peek a caller is waiting on: the claim it went out under, which the receipt has
// to quote, the call to resolve, and what the receipt answering it means. Only the caller knows
// that last part, since a taken order answers with the session the host named and a taken peek
// with the session it asked about. The map lives in the same isolate as the call, which is the
// whole of the mailbox's in-flight state.
interface Pending {
  token: string;
  resolve: (outcome: Outcome) => void;
  settled: (receipt: Receipt) => Outcome;
  lapse: ReturnType<typeof setTimeout>;
}

const readJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// What a receipt answers is read off the word it leads with, and the claim it names follows from
// that: a peek receipt names a peek and an order's names a message.
const parseReceipt = (raw: string): Receipt | null => {
  const frame = readJson(raw);
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return null;
  const { type, messageId, peekId, sessionId, token } = frame as Record<string, unknown>;
  if (typeof token !== "string" || token.length < 1) return null;
  if (type === "peek-took" || type === "peek-none") {
    if (typeof peekId !== "string" || peekId.length < 1) return null;
    return { type, peekId, token };
  }
  if (typeof messageId !== "string" || messageId.length < 1) return null;
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

const pushed = (message: Message): Pushed => ({ ...message, expiresAt: message.createdAt });

const newsFrame = (message: Message): string =>
  JSON.stringify({ type: "message", message: pushed(message) } satisfies NewsFrame);

const orderFrame = (message: Message, token: string): string =>
  JSON.stringify({ type: "order", message: pushed(message), token } satisfies OrderFrame);

const peekFrame = (peek: PeekOrder, token: string): string =>
  JSON.stringify({ type: "peek", peek, token } satisfies PeekFrame);

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

export class Mailbox extends DurableObject {
  private readonly waiting = new Map<string, Pending>();

  // A socket attaching is handed nothing. A message is a ping that was relevant when it was sent,
  // and this socket was not there for it.
  async fetch(request: Request): Promise<Response> {
    const deviceId = request.headers.get(DEVICE_HEADER) ?? "";
    if (deviceId === "") return new Response("the mailbox only answers the listen upgrade", { status: 400 });
    const orders = request.headers.get(ORDERS_HEADER) === ORDERS;
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ deviceId, orders } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Only a receipt is read, and only by the send it quotes. A frame that is not one is ignored
  // exactly as one quoting a claim no send is waiting on is: a daemon from before orders answers
  // news with an ack, and a socket closed over that would reconnect into the same ack forever.
  async webSocketMessage(_socket: WebSocket, received: string | ArrayBuffer): Promise<void> {
    const receipt = typeof received === "string" ? parseReceipt(received) : null;
    if (receipt === null) return;
    this.settle(receipt);
  }

  // Closes the sockets of a device that is no longer signed in, which the revocation itself calls
  // so the device stops reading news the moment it loses its login.
  async revoke(deviceId: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      if (deviceOf(socket) === deviceId) {
        socket.close(CLOSE_REVOKED, "this device is no longer signed in; run recall login");
      }
    }
  }

  async publish(input: SendInput, from: Sender, now: number): Promise<Sent> {
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

  // One session asked what it is doing. The row the digest lands on is written before this is
  // called, so a host that answers the moment it reads the frame writes onto a peek that is there.
  async peek(order: PeekOrder): Promise<Outcome> {
    const token = this.hand(order.toDeviceId, (claim) => peekFrame(order, claim));
    if (token === null) return { state: "untaken", reason: NO_PEEK_LISTENING };
    return await this.taker(order.peekId, token, PEEK_NOT_TAKEN, (receipt) =>
      receipt.type === "peek-took"
        ? { state: "taken", sessionId: order.sessionId }
        : { state: "untaken", reason: NOT_SUMMARISED },
    );
  }

  // News is published to whoever is attached and nothing is waited on: the push is the whole of
  // the bus's obligation, and a host that was not listening has nothing kept for it. An order goes
  // to one socket, and the sender waits for the receipt naming the session that ran it.
  private async place(message: Message): Promise<Outcome> {
    if (message.kind === "news") {
      this.broadcast(message);
      return { state: "fanout" };
    }
    const token = this.hand(message.toDeviceId, (claim) => orderFrame(message, claim));
    if (token === null) return { state: "untaken", reason: NOTHING_LISTENING };
    return await this.taker(message.messageId, token, NOT_TAKEN, (receipt) =>
      receipt.type === "took"
        ? { state: "taken", sessionId: receipt.sessionId }
        : { state: "untaken", reason: NO_SESSION_TOOK_IT },
    );
  }

  private broadcast(message: Message): void {
    const frame = newsFrame(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (deviceOf(socket) === message.toDeviceId) deliver(socket, frame);
    }
  }

  // One frame to one live socket that declared it reads kinds, under the claim that socket has to
  // quote to settle it. A daemon too old to read a kind would write the order into every session it
  // has, so it is handed none and the sender is told nobody took it.
  private hand(toDeviceId: string, frame: (token: string) => string): string | null {
    for (const socket of this.ctx.getWebSockets()) {
      const to = attached(socket);
      if (to === null || !to.orders || to.deviceId !== toDeviceId) continue;
      const token = crypto.randomUUID();
      if (deliver(socket, frame(token))) return token;
    }
    return null;
  }

  private taker(
    claim: string,
    token: string,
    dropped: string,
    settled: (receipt: Receipt) => Outcome,
  ): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      const lapse = setTimeout(() => {
        this.waiting.delete(claim);
        resolve({ state: "untaken", reason: dropped });
      }, TAKER_WINDOW_MS);
      this.waiting.set(claim, { token, resolve, settled, lapse });
    });
  }

  // A receipt settles the order or peek it names only if it quotes the claim that one went out
  // under, so a daemon quoting an id it has seen before cannot answer for one it was never handed.
  private settle(receipt: Receipt): void {
    const claim = peeked(receipt) ? receipt.peekId : receipt.messageId;
    const pending = this.waiting.get(claim);
    if (pending === undefined || pending.token !== receipt.token) return;
    clearTimeout(pending.lapse);
    this.waiting.delete(claim);
    pending.resolve(pending.settled(receipt));
  }
}
