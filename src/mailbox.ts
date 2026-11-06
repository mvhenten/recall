import { DurableObject } from "cloudflare:workers";
import { listDevices } from "./device";
import { type Parsed, parseSessionId } from "./model";

// A message is a ping that is relevant now. It goes to the sockets attached when it is sent and to
// nothing else: the bus is not a board a session reads at boot, so one that was not listening then
// never sees it, and the sender is told nobody got it. The TTL is the outer bound on a row that is
// still in flight, not a window anything waits in.
export const MESSAGE_TTL_MS = 10_000;
export const MAX_QUEUED_MESSAGES = 1_000;
export const MAX_BODY_BYTES = 32_768;
export const SWEEP_INTERVAL_MS = 900_000;

// How long one socket holds an order to itself, so no other connection sees it while that one is
// writing it into a session. A minute is ten of the five second timeouts the daemon allows itself
// for that write. Nothing is handed out again when it lapses; it only reclaims the row of a holder
// that was evicted before its receipt landed.
export const LEASE_MS = 60_000;

// How long a send waits for the host to name the session that took an order, and the whole life of
// an untaken one: a host that is listening and has said nothing by then loses the order, since a
// sender told the order failed must not leave one behind for a session to run later.
export const TAKER_WINDOW_MS = 10_000;

export const DEVICE_HEADER = "x-recall-device-id";
export const NOW_HEADER = "x-recall-now";

// What the daemon declares on the upgrade: it reads a message's kind, so an order written into one
// of its sessions stays with that one. A socket that declares nothing predates orders and would
// fan one out to every session there, so the mailbox holds its orders back.
export const ORDERS_HEADER = "x-recall-orders";
export const ORDERS = "1";

export const CLOSE_BAD_FRAME = 4000;
export const CLOSE_REVOKED = 4001;

export const NOTHING_LISTENING =
  "no host is listening as that device, so nothing was delivered; the bus holds nothing for one that attaches later";
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
  expiresAt: number;
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

// What the send tells its sender. `reason` is what the sender prints when nobody took the order.
export type Outcome =
  | { state: "fanout" }
  | { state: "taken"; sessionId: string }
  | { state: "untaken"; reason: string };

// What a send that found room becomes: the message as it was queued, and what became of it.
export interface Sent {
  message: Message;
  outcome: Outcome;
}

// `token` is the claim this frame hands the socket, which the receipt has to quote. The mailbox
// records one only for an order, the one kind a socket holds against another.
export interface MessageFrame {
  type: "message";
  message: Message;
  token: string;
}

export interface AckFrame {
  type: "ack";
  messageId: string;
  token: string;
}

export interface TookFrame {
  type: "took";
  messageId: string;
  sessionId: string;
  token: string;
}

// A host that writes neither says nothing, and the send gives up on the order when its window
// closes.
export type Receipt = AckFrame | TookFrame;

export interface MailboxEnv {
  DB: D1Database;
}

// `orders` is what the socket declared on the upgrade: whether the daemon behind it reads the kind
// of a message. A socket attached before the mailbox asked declares nothing and gets no order.
interface Attachment {
  deviceId: string;
  orders: boolean;
}

const COLUMNS =
  "message_id, kind, to_device_id, to_session_id, from_device_id, from_host, from_name, body, created_at, expires_at";

const liveSince = (now: number): number => now - MESSAGE_TTL_MS;

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

// A host too old to quote a token claims nothing, which releases news and never an order.
const parseReceipt = (raw: string): Receipt | null => {
  const frame = readJson(raw);
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return null;
  const { type, messageId, sessionId, token } = frame as Record<string, unknown>;
  if (typeof messageId !== "string" || messageId.length < 1) return null;
  const claim = typeof token === "string" ? token : "";
  if (type === "ack") return { type: "ack", messageId, token: claim };
  if (type !== "took" || typeof sessionId !== "string") return null;
  const took = parseSessionId(sessionId);
  if (!took.ok) return null;
  return { type: "took", messageId, sessionId: took.value, token: claim };
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
  private readonly sql: SqlStorage;
  private readonly waiting = new Map<string, (outcome: Outcome) => void>();

  constructor(ctx: DurableObjectState, env: MailboxEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (
         message_id TEXT PRIMARY KEY,
         kind TEXT NOT NULL DEFAULT 'news',
         to_device_id TEXT NOT NULL,
         to_session_id TEXT NOT NULL DEFAULT '',
         from_device_id TEXT NOT NULL,
         from_host TEXT NOT NULL DEFAULT '',
         from_name TEXT NOT NULL DEFAULT '',
         body TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS messages_by_device ON messages (to_device_id, created_at, message_id)");
    // One row per order a socket is holding: the token it has to quote to release it. An order
    // lives only between the push and the receipt, so nothing here is ever waited on or aged out.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS order_tokens (
         message_id TEXT PRIMARY KEY,
         token TEXT NOT NULL
       )`,
    );
    // `leases` was the same rows under an expiry nothing could reach, and the index over it. Its
    // rows only ever described an order in flight, so a mailbox loses nothing by dropping it.
    this.sql.exec("DROP TABLE IF EXISTS leases");
    // A mailbox created before per-session addressing has no to_session_id, and its queued messages
    // are all for the whole host; one created before a message named its sender has no from_host or
    // from_name, and its queued messages are delivered under a header that names neither; one
    // created before orders has no kind. `PRAGMA user_version` is one of the pragmas a Durable
    // Object refuses, so the columns themselves are the version marker.
    const columns = new Set(
      this.sql
        .exec<{ name: string }>("PRAGMA table_info(messages)")
        .toArray()
        .map((column) => column.name),
    );
    if (!columns.has("to_session_id")) {
      this.sql.exec("ALTER TABLE messages ADD COLUMN to_session_id TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.has("from_host")) {
      this.sql.exec("ALTER TABLE messages ADD COLUMN from_host TEXT NOT NULL DEFAULT ''");
      this.sql.exec("ALTER TABLE messages ADD COLUMN from_name TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.has("kind")) {
      this.sql.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'news'");
    }
  }

  async fetch(request: Request): Promise<Response> {
    const deviceId = request.headers.get(DEVICE_HEADER) ?? "";
    const now = Number(request.headers.get(NOW_HEADER));
    if (deviceId === "" || !Number.isFinite(now)) {
      return new Response("the mailbox only answers the listen upgrade", { status: 400 });
    }
    const orders = request.headers.get(ORDERS_HEADER) === ORDERS;
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ deviceId, orders } satisfies Attachment);
    // A socket attaching is handed nothing. A message is a ping that was relevant when it was
    // sent, and this socket was not there for it; the sender has already been told nobody got it.
    this.expire(now);
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, received: string | ArrayBuffer): Promise<void> {
    const deviceId = deviceOf(socket);
    const receipt = typeof received === "string" ? parseReceipt(received) : null;
    if (deviceId === null || receipt === null) {
      socket.close(
        CLOSE_BAD_FRAME,
        'every frame must be {"type":"ack","messageId":"<id>","token":"<token>"} or {"type":"took","messageId":"<id>","sessionId":"<id>","token":"<token>"}',
      );
      return;
    }
    if (this.remove(deviceId, receipt.messageId, receipt.token)) this.settle(receipt);
    await this.scheduleAlarm();
  }

  async alarm(): Promise<void> {
    await this.sweep(Date.now());
    await this.scheduleAlarm();
  }

  async enqueue(input: SendInput, from: Sender, now: number): Promise<Sent | null> {
    this.expire(now);
    if (this.queued() >= MAX_QUEUED_MESSAGES) return null;
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
      expiresAt: now + MESSAGE_TTL_MS,
    };
    this.sql.exec(
      `INSERT INTO messages (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.messageId,
      message.kind,
      message.toDeviceId,
      message.toSessionId,
      message.fromDeviceId,
      message.fromHost,
      message.fromName,
      message.body,
      message.createdAt,
      message.expiresAt,
    );
    const outcome = await this.place(message);
    await this.scheduleAlarm();
    return { message, outcome };
  }

  // Whoever is attached takes the message, and a sender whose message reached nobody is told so
  // rather than left to assume it landed. News goes to every socket the device has open; an order
  // goes to one, and the sender waits for the receipt naming the session that ran it.
  private async place(message: Message): Promise<Outcome> {
    if (message.kind === "news") {
      if (this.broadcast(message) > 0) return { state: "fanout" };
      this.drop(message.toDeviceId, message.messageId);
      return { state: "untaken", reason: NOTHING_LISTENING };
    }
    if (!this.hand(message)) {
      this.drop(message.toDeviceId, message.messageId);
      return { state: "untaken", reason: NOTHING_LISTENING };
    }
    const outcome = await this.taker(message.messageId);
    if (outcome.state === "untaken") this.drop(message.toDeviceId, message.messageId);
    return outcome;
  }

  // A receipt releases the message it names only if it quotes that frame's token, so a daemon
  // acking an id it has seen before cannot delete an order another socket is still placing.
  private remove(toDeviceId: string, messageId: string, token: string): boolean {
    const [held] = this.sql
      .exec<{ token: string }>("SELECT token FROM order_tokens WHERE message_id = ?", messageId)
      .toArray();
    if (held !== undefined && held.token !== token) return false;
    return this.drop(toDeviceId, messageId);
  }

  // A socket releases its own device's messages and nothing else, so the id of one sent elsewhere
  // is no use to it.
  private drop(toDeviceId: string, messageId: string): boolean {
    const removed = this.sql.exec(
      "DELETE FROM messages WHERE to_device_id = ? AND message_id = ?",
      toDeviceId,
      messageId,
    ).rowsWritten;
    if (removed === 0) return false;
    this.sql.exec("DELETE FROM order_tokens WHERE message_id = ?", messageId);
    return true;
  }

  private settle(receipt: Receipt): void {
    const waiting = this.waiting.get(receipt.messageId);
    if (waiting === undefined) return;
    waiting(
      receipt.type === "took"
        ? { state: "taken", sessionId: receipt.sessionId }
        : { state: "untaken", reason: NO_SESSION_TOOK_IT },
    );
  }

  // How many sockets the news reached, so a send that reached none can say so.
  private broadcast(message: Message): number {
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      if (deviceOf(socket) !== message.toDeviceId) continue;
      if (deliver(socket, messageFrame(message, crypto.randomUUID()))) delivered += 1;
    }
    return delivered;
  }

  // One order to one live socket that declared it reads kinds, under a token that socket has to
  // quote to release it. A daemon too old to read a kind would write the order into every session
  // it has, so it is handed none and the sender is told nobody took it.
  private hand(message: Message): boolean {
    for (const socket of this.ctx.getWebSockets()) {
      const to = attached(socket);
      if (to === null || !to.orders || to.deviceId !== message.toDeviceId) continue;
      const token = crypto.randomUUID();
      if (!deliver(socket, messageFrame(message, token))) continue;
      this.sql.exec("INSERT OR REPLACE INTO order_tokens (message_id, token) VALUES (?, ?)", message.messageId, token);
      return true;
    }
    return false;
  }

  private taker(messageId: string): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      const lapse = setTimeout(() => {
        this.waiting.delete(messageId);
        resolve({ state: "untaken", reason: NOT_TAKEN });
      }, TAKER_WINDOW_MS);
      this.waiting.set(messageId, (outcome) => {
        clearTimeout(lapse);
        this.waiting.delete(messageId);
        resolve(outcome);
      });
    });
  }

  // The quarter-hourly pass, and the only thing the alarm is for: take out rows nothing acked,
  // forget the rows of a device that is gone, and close the socket of one that is revoked.
  private async sweep(now: number): Promise<void> {
    if (now < (await this.sweepDue())) return;
    await this.ctx.storage.put(SWEPT_AT, now);
    this.expire(now);
    const live = await this.liveDevices();
    this.reap(live);
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

  private reap(live: Set<string>): void {
    const targets = this.sql.exec<{ to_device_id: string }>("SELECT DISTINCT to_device_id FROM messages").toArray();
    for (const target of targets) {
      if (live.has(target.to_device_id)) continue;
      this.sql.exec(
        "DELETE FROM order_tokens WHERE message_id IN (SELECT message_id FROM messages WHERE to_device_id = ?)",
        target.to_device_id,
      );
      this.sql.exec("DELETE FROM messages WHERE to_device_id = ?", target.to_device_id);
    }
  }

  private queued(): number {
    return this.sql.exec<{ queued: number }>("SELECT count(*) AS queued FROM messages").one().queued;
  }

  // The next sweep, which falls a quarter hour after the last one however much traffic arrives in
  // between. A mailbox holding nothing with nobody attached owes nothing and stops waking up.
  private async scheduleAlarm(): Promise<void> {
    if (this.queued() === 0 && this.ctx.getWebSockets().length === 0) return;
    await this.ctx.storage.setAlarm(await this.sweepDue());
  }

  // When the next quarter-hourly pass falls due. A mailbox that has never made one dates its first
  // from the moment it had anything to wake up for, so arming the alarm never asks for a pass in
  // the past and a stream of sends cannot keep pushing the next one out of reach.
  private async sweepDue(): Promise<number> {
    const sweptAt = await this.ctx.storage.get<number>(SWEPT_AT);
    if (sweptAt !== undefined) return sweptAt + SWEEP_INTERVAL_MS;
    const now = Date.now();
    await this.ctx.storage.put(SWEPT_AT, now);
    return now + SWEEP_INTERVAL_MS;
  }

  // Takes out a row no receipt ever released. Nothing is delivered from a row, so this only keeps
  // the table from growing: whatever a deploy or a dropped socket left behind goes on the next
  // thing that happens to the mailbox.
  private expire(now: number): void {
    const since = liveSince(now);
    this.sql.exec(
      "DELETE FROM order_tokens WHERE message_id IN (SELECT message_id FROM messages WHERE created_at <= ?)",
      since,
    );
    this.sql.exec("DELETE FROM messages WHERE created_at <= ?", since);
  }
}
