import { DurableObject } from "cloudflare:workers";
import { listDevices } from "./device";
import { type Parsed, parseSessionId } from "./model";

export const MESSAGE_TTL_MS = 259_200_000;
export const MAX_QUEUED_MESSAGES = 1_000;
export const MAX_BODY_BYTES = 32_768;
export const SWEEP_INTERVAL_MS = 900_000;

// How long one session holds an order before the mailbox hands it to whoever is listening next. A
// minute is ten of the five second timeouts the daemon allows itself to write into a session, and
// the ceiling of its reconnect backoff, past which a host that died holding an order cannot be
// the one to hand it back.
export const LEASE_MS = 60_000;

// How long a send waits for the host to name the session that took an order, and the whole life of
// an untaken one: a host that is listening and has said nothing by then loses the order, since a
// sender told the order failed must not leave one behind for a session to run later.
export const TAKER_WINDOW_MS = 10_000;

export const DEVICE_HEADER = "x-recall-device-id";
export const NOW_HEADER = "x-recall-now";

export const CLOSE_BAD_FRAME = 4000;
export const CLOSE_REVOKED = 4001;

export const NOTHING_LISTENING = "no host is listening as that device, so nothing can take the order";
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

export type Queued = { queued: false } | { queued: true; message: Message; outcome: Outcome };

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

// A host that writes neither leaves the lease to expire, and the order goes out again.
export type Receipt = AckFrame | TookFrame;

export interface MailboxEnv {
  DB: D1Database;
}

interface MessageRow extends Record<string, string | number> {
  message_id: string;
  kind: string;
  to_device_id: string;
  to_session_id: string;
  from_device_id: string;
  from_host: string;
  from_name: string;
  body: string;
  created_at: number;
  expires_at: number;
}

interface Attachment {
  deviceId: string;
}

const COLUMNS =
  "message_id, kind, to_device_id, to_session_id, from_device_id, from_host, from_name, body, created_at, expires_at";

const kindOf = (value: string): MessageKind => {
  if (value === "news" || value === "order") return value;
  throw new Error(`the mailbox holds a message of kind ${value}, which is neither news nor an order`);
};

const toMessage = (row: MessageRow): Message => ({
  messageId: row.message_id,
  kind: kindOf(row.kind),
  toDeviceId: row.to_device_id,
  toSessionId: row.to_session_id,
  fromDeviceId: row.from_device_id,
  fromHost: row.from_host,
  fromName: row.from_name,
  body: row.body,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

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

const deviceOf = (socket: WebSocket): string | null => {
  const stored: unknown = socket.deserializeAttachment();
  if (typeof stored !== "object" || stored === null) return null;
  const { deviceId } = stored as Record<string, unknown>;
  return typeof deviceId === "string" ? deviceId : null;
};

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
const SWEPT_AT = "sweptAt";

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
    // One row per order a host is holding, so the table is the whole of the lease state, and
    // `token` is what the holder has to quote to release it.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS leases (
         message_id TEXT PRIMARY KEY,
         expires_at INTEGER NOT NULL,
         token TEXT NOT NULL
       )`,
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS leases_by_expiry ON leases (expires_at)");
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
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ deviceId } satisfies Attachment);
    for (const message of this.deliverable(deviceId, now)) {
      const token = crypto.randomUUID();
      pair[1].send(messageFrame(message, token));
      if (message.kind === "order") this.lease(message.messageId, token, now);
    }
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
    if (this.remove(receipt.messageId, receipt.token)) {
      this.settle(receipt);
      const next = this.nextOrder(deviceId);
      if (next !== null) this.hand(next, Date.now());
    }
    await this.scheduleAlarm();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.handBack(now);
    await this.sweep(now);
    await this.scheduleAlarm();
  }

  // `window` belongs to the send and not to the mailbox: it is how long that sender is willing to
  // wait for the host to name the session that took its order.
  async enqueue(input: SendInput, from: Sender, now: number, window: number): Promise<Queued> {
    this.expire(now);
    if (this.queued() >= MAX_QUEUED_MESSAGES) return { queued: false };
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
    const outcome = await this.place(message, now, window);
    await this.scheduleAlarm();
    return { queued: true, message, outcome };
  }

  list(toDeviceId: string, now: number): Message[] {
    this.expire(now);
    return this.rows("WHERE to_device_id = ?", toDeviceId);
  }

  // News is handed out and nothing is waited on. An order goes to one socket, and the sender waits
  // for the receipt naming the session: a host that answers nothing within the window loses the
  // order, while one that was never listening keeps it for the next socket to attach.
  private async place(message: Message, now: number, window: number): Promise<Outcome> {
    if (message.kind === "news") {
      this.broadcast(message);
      return { state: "fanout" };
    }
    if (!this.hand(message, now)) return { state: "untaken", reason: NOTHING_LISTENING };
    const outcome = await this.taker(message.messageId, window);
    if (outcome.state === "untaken") this.drop(message.messageId);
    return outcome;
  }

  // Everything the attaching host may have now: all its news, and one order no session is holding.
  // Its other orders wait for the receipt on this one, since a host places them one at a time.
  private deliverable(toDeviceId: string, now: number): Message[] {
    this.expire(now);
    this.release(now);
    const news = this.rows("WHERE to_device_id = ? AND kind = 'news'", toDeviceId);
    const order = this.nextOrder(toDeviceId);
    return order === null ? news : [...news, order];
  }

  // The one order a device may be handed next: the oldest under no lease. A second lease started
  // now would run out while the host was still writing the first order into a session.
  private nextOrder(toDeviceId: string): Message | null {
    const [row] = this.sql
      .exec<MessageRow>(
        `SELECT ${COLUMNS} FROM messages
           WHERE to_device_id = ? AND kind = 'order' AND message_id NOT IN (SELECT message_id FROM leases)
           ORDER BY created_at, rowid LIMIT 1`,
        toDeviceId,
      )
      .toArray();
    return row === undefined ? null : toMessage(row);
  }

  private rows(where: string, toDeviceId: string): Message[] {
    return this.sql
      .exec<MessageRow>(`SELECT ${COLUMNS} FROM messages ${where} ORDER BY created_at, rowid`, toDeviceId)
      .toArray()
      .map(toMessage);
  }

  // A receipt releases the message it names only if it quotes that frame's token, so a daemon
  // acking an id out of an old backlog cannot delete an order another socket is still placing.
  private remove(messageId: string, token: string): boolean {
    const [held] = this.sql
      .exec<{ token: string }>("SELECT token FROM leases WHERE message_id = ?", messageId)
      .toArray();
    if (held !== undefined && held.token !== token) return false;
    return this.drop(messageId);
  }

  private drop(messageId: string): boolean {
    this.sql.exec("DELETE FROM leases WHERE message_id = ?", messageId);
    return this.sql.exec("DELETE FROM messages WHERE message_id = ?", messageId).rowsWritten > 0;
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

  private broadcast(message: Message): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (deviceOf(socket) === message.toDeviceId) deliver(socket, messageFrame(message, crypto.randomUUID()));
    }
  }

  // One order to one live socket, held under a lease until that host reports what became of it.
  private hand(message: Message, now: number): boolean {
    for (const socket of this.ctx.getWebSockets()) {
      if (deviceOf(socket) !== message.toDeviceId) continue;
      const token = crypto.randomUUID();
      if (!deliver(socket, messageFrame(message, token))) continue;
      this.lease(message.messageId, token, now);
      return true;
    }
    return false;
  }

  private lease(messageId: string, token: string, now: number): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO leases (message_id, expires_at, token) VALUES (?, ?, ?)",
      messageId,
      now + LEASE_MS,
      token,
    );
  }

  private release(now: number): void {
    this.sql.exec("DELETE FROM leases WHERE expires_at <= ?", now);
  }

  // The devices whose lease has run out, each offered one order again. A host that is gone takes
  // nothing and its orders wait, under no lease, for the next socket to attach.
  private handBack(now: number): void {
    const devices = this.sql
      .exec<{ to_device_id: string }>(
        `SELECT DISTINCT to_device_id FROM messages
           WHERE message_id IN (SELECT message_id FROM leases WHERE expires_at <= ?)`,
        now,
      )
      .toArray();
    this.release(now);
    for (const device of devices) {
      const next = this.nextOrder(device.to_device_id);
      if (next !== null) this.hand(next, now);
    }
  }

  private taker(messageId: string, window: number): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      const lapse = setTimeout(() => {
        this.waiting.delete(messageId);
        resolve({ state: "untaken", reason: NOT_TAKEN });
      }, window);
      this.waiting.set(messageId, (outcome) => {
        clearTimeout(lapse);
        this.waiting.delete(messageId);
        resolve(outcome);
      });
    });
  }

  // The quarter-hourly pass: retire what has expired, forget the messages of a device that is
  // gone, and close the socket of one that is revoked. It shares the lease alarm, and a lease due
  // sooner does not bring it forward.
  private async sweep(now: number): Promise<void> {
    const sweptAt = (await this.ctx.storage.get<number>(SWEPT_AT)) ?? 0;
    if (now - sweptAt < SWEEP_INTERVAL_MS) return;
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
        "DELETE FROM leases WHERE message_id IN (SELECT message_id FROM messages WHERE to_device_id = ?)",
        target.to_device_id,
      );
      this.sql.exec("DELETE FROM messages WHERE to_device_id = ?", target.to_device_id);
    }
  }

  private queued(): number {
    return this.sql.exec<{ queued: number }>("SELECT count(*) AS queued FROM messages").one().queued;
  }

  // One alarm, set to the earliest thing the mailbox owes: the next lease expiry, which hands an
  // order a host never answered for to whoever is listening then, or the sweep. A mailbox holding
  // nothing with nobody attached owes neither and stops waking up.
  private async scheduleAlarm(): Promise<void> {
    const due = this.sql.exec<{ due: number | null }>("SELECT min(expires_at) AS due FROM leases").one().due;
    if (due === null && this.queued() === 0 && this.ctx.getWebSockets().length === 0) return;
    await this.ctx.storage.setAlarm(due ?? Date.now() + SWEEP_INTERVAL_MS);
  }

  private expire(now: number): void {
    this.sql.exec(
      "DELETE FROM leases WHERE message_id IN (SELECT message_id FROM messages WHERE expires_at <= ?)",
      now,
    );
    this.sql.exec("DELETE FROM messages WHERE expires_at <= ?", now);
  }
}
