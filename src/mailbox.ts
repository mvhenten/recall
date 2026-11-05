import { DurableObject } from "cloudflare:workers";
import { listDevices } from "./device";
import { type Parsed, parseSessionId } from "./model";

export const MESSAGE_TTL_MS = 259_200_000;
export const MAX_QUEUED_MESSAGES = 1_000;
export const MAX_BODY_BYTES = 32_768;
export const SWEEP_INTERVAL_MS = 900_000;

// How long one session holds an order before the mailbox hands it to whoever is listening next.
// It bounds the round trip from the push to the receipt: the daemon writes the order into a
// session's inbox under its own five second timeout and reports back over the same socket, so a
// minute is ten delivery attempts, and it is also the ceiling of the daemon's reconnect backoff,
// past which a host that died holding an order cannot be the one to hand it back.
export const LEASE_MS = 60_000;

// How long a send waits for the host to say which session took the order. A listening daemon
// answers within a round trip; past this the sender is told the order is queued and untaken.
export const TAKER_WINDOW_MS = 10_000;

export const DEVICE_HEADER = "x-recall-device-id";
export const NOW_HEADER = "x-recall-now";

export const CLOSE_BAD_FRAME = 4000;
export const CLOSE_REVOKED = 4001;

export const NOTHING_LISTENING = "no host is listening as that device, so nothing can take the order";
export const NOT_TAKEN_YET = "the host is listening but no session has taken the order yet";
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

// What the send tells its sender. News is queued for the whole host and nothing is waited on; an
// order is either taken by one named session or it is not, and `reason` is what the sender prints.
export type Outcome =
  | { state: "fanout" }
  | { state: "taken"; sessionId: string }
  | { state: "untaken"; reason: string };

export type Queued = { queued: false } | { queued: true; message: Message; outcome: Outcome };

export interface MessageFrame {
  type: "message";
  message: Message;
}

export interface AckFrame {
  type: "ack";
  messageId: string;
}

export interface TookFrame {
  type: "took";
  messageId: string;
  sessionId: string;
}

// The two receipts a host sends back. Both release the row; `took` also names the session that
// has the order, which is what the sender is waiting to hear. A host that writes neither leaves
// the lease to expire, and the order goes out again.
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

const toMessage = (row: MessageRow): Message => ({
  messageId: row.message_id,
  kind: row.kind === "order" ? "order" : "news",
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

// A sender too old to name a kind is sending news, which is what every send meant before orders.
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
  const { type, messageId, sessionId } = frame as Record<string, unknown>;
  if (typeof messageId !== "string" || messageId.length < 1) return null;
  if (type === "ack") return { type: "ack", messageId };
  if (type !== "took" || typeof sessionId !== "string" || sessionId.length < 1) return null;
  return { type: "took", messageId, sessionId };
};

const deviceOf = (socket: WebSocket): string | null => {
  const stored: unknown = socket.deserializeAttachment();
  if (typeof stored !== "object" || stored === null) return null;
  const { deviceId } = stored as Record<string, unknown>;
  return typeof deviceId === "string" ? deviceId : null;
};

const messageFrame = (message: Message): string => JSON.stringify({ type: "message", message } satisfies MessageFrame);

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
    // One row per order a host is holding, and none for an order nothing holds, so the table is
    // the whole of the lease state. The alarm reads its earliest expiry and nothing else.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS leases (
         message_id TEXT PRIMARY KEY,
         expires_at INTEGER NOT NULL
       )`,
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS leases_by_expiry ON leases (expires_at)");
    // A mailbox created before per-session addressing has no to_session_id, and its queued messages
    // are all for the whole host; one created before a message named its sender has no from_host or
    // from_name, and its queued messages are delivered under a header that names neither; one
    // created before orders has no kind, and everything it holds is news.
    // `PRAGMA user_version` is one of the pragmas a Durable Object refuses, so the columns
    // themselves are the version marker.
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
      pair[1].send(messageFrame(message));
      if (message.kind === "order") this.lease(message.messageId, now);
    }
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket: WebSocket, received: string | ArrayBuffer): void {
    const deviceId = deviceOf(socket);
    const receipt = typeof received === "string" ? parseReceipt(received) : null;
    if (deviceId === null || receipt === null) {
      socket.close(
        CLOSE_BAD_FRAME,
        'every frame must be {"type":"ack","messageId":"<id>"} or {"type":"took","messageId":"<id>","sessionId":"<id>"}',
      );
      return;
    }
    if (!this.remove(deviceId, receipt.messageId)) return;
    const settle = this.waiting.get(receipt.messageId);
    if (settle === undefined) return;
    settle(
      receipt.type === "took"
        ? { state: "taken", sessionId: receipt.sessionId }
        : { state: "untaken", reason: NO_SESSION_TOOK_IT },
    );
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.handBack(now);
    this.expire(now);
    const live = await this.liveDevices();
    this.reap(live);
    for (const socket of this.ctx.getWebSockets()) {
      const deviceId = deviceOf(socket);
      if (deviceId === null || !live.has(deviceId)) {
        socket.close(CLOSE_REVOKED, "this device is no longer signed in; run recall login");
      }
    }
    await this.scheduleAlarm();
  }

  // `window` is how long the sender is willing to wait for the host to name the session that took
  // an order, which belongs to the send and not to the mailbox. News never waits.
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
    if (message.kind === "news") {
      this.broadcast(message);
      await this.scheduleAlarm();
      return { queued: true, message, outcome: { state: "fanout" } };
    }
    const handed = this.hand(message, now);
    await this.scheduleAlarm();
    if (!handed) return { queued: true, message, outcome: { state: "untaken", reason: NOTHING_LISTENING } };
    return { queued: true, message, outcome: await this.taker(message.messageId, window) };
  }

  list(toDeviceId: string, now: number): Message[] {
    this.expire(now);
    return this.rows("WHERE to_device_id = ?", toDeviceId);
  }

  // Everything the attaching host may have: all its news, and the orders no session is holding.
  // An order under a live lease is invisible here, which is what keeps a second socket, or the
  // same socket reconnecting, from running an order a session already has.
  private deliverable(toDeviceId: string, now: number): Message[] {
    this.expire(now);
    this.release(now);
    return this.rows(
      "WHERE to_device_id = ? AND (kind = 'news' OR message_id NOT IN (SELECT message_id FROM leases))",
      toDeviceId,
    );
  }

  private rows(where: string, toDeviceId: string): Message[] {
    return this.sql
      .exec<MessageRow>(`SELECT ${COLUMNS} FROM messages ${where} ORDER BY created_at, rowid`, toDeviceId)
      .toArray()
      .map(toMessage);
  }

  private remove(toDeviceId: string, messageId: string): boolean {
    const removed =
      this.sql.exec("DELETE FROM messages WHERE to_device_id = ? AND message_id = ?", toDeviceId, messageId)
        .rowsWritten > 0;
    if (removed) this.sql.exec("DELETE FROM leases WHERE message_id = ?", messageId);
    return removed;
  }

  private broadcast(message: Message): void {
    const frame = messageFrame(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (deviceOf(socket) === message.toDeviceId) socket.send(frame);
    }
  }

  // One order to one socket, held under a lease until that host reports what became of it.
  private hand(message: Message, now: number): boolean {
    const socket = this.ctx.getWebSockets().find((candidate) => deviceOf(candidate) === message.toDeviceId);
    if (socket === undefined) return false;
    socket.send(messageFrame(message));
    this.lease(message.messageId, now);
    return true;
  }

  private lease(messageId: string, now: number): void {
    this.sql.exec("INSERT OR REPLACE INTO leases (message_id, expires_at) VALUES (?, ?)", messageId, now + LEASE_MS);
  }

  private release(now: number): void {
    this.sql.exec("DELETE FROM leases WHERE expires_at <= ?", now);
  }

  // The orders whose lease has run out, handed to whoever is listening now. A host that is gone
  // takes nothing and the order waits, under no lease, for the next socket to attach.
  private handBack(now: number): void {
    const expired = this.sql
      .exec<{ message_id: string }>("SELECT message_id FROM leases WHERE expires_at <= ?", now)
      .toArray()
      .map((row) => row.message_id);
    this.release(now);
    for (const messageId of expired) {
      const row = this.sql
        .exec<MessageRow>(`SELECT ${COLUMNS} FROM messages WHERE message_id = ?`, messageId)
        .toArray();
      const held = row[0];
      if (held === undefined) continue;
      this.hand(toMessage(held), now);
    }
  }

  private taker(messageId: string, window: number): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      const lapse = setTimeout(() => {
        this.waiting.delete(messageId);
        resolve({ state: "untaken", reason: NOT_TAKEN_YET });
      }, window);
      this.waiting.set(messageId, (outcome) => {
        clearTimeout(lapse);
        this.waiting.delete(messageId);
        resolve(outcome);
      });
    });
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
      if (!live.has(target.to_device_id)) {
        this.sql.exec("DELETE FROM messages WHERE to_device_id = ?", target.to_device_id);
      }
    }
    this.forgetOrphanLeases();
  }

  private queued(): number {
    return this.sql.exec<{ queued: number }>("SELECT count(*) AS queued FROM messages").one().queued;
  }

  // One alarm, set to the earliest thing the mailbox owes: the next lease expiry, which hands an
  // order a host never answered for to whoever is listening then, or the sweep that retires
  // expired rows and closes the socket of a revoked device. A lease due sooner than the alarm
  // already standing lowers it; nothing here reads a row that is not already due.
  private async scheduleAlarm(): Promise<void> {
    const standing = await this.ctx.storage.getAlarm();
    const due = this.sql.exec<{ due: number | null }>("SELECT min(expires_at) AS due FROM leases").one().due;
    if (due === null) {
      if (standing !== null) return;
      if (this.queued() === 0 && this.ctx.getWebSockets().length === 0) return;
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
      return;
    }
    if (standing !== null && standing <= due) return;
    await this.ctx.storage.setAlarm(due);
  }

  private expire(now: number): void {
    this.sql.exec("DELETE FROM messages WHERE expires_at <= ?", now);
    this.forgetOrphanLeases();
  }

  private forgetOrphanLeases(): void {
    this.sql.exec("DELETE FROM leases WHERE message_id NOT IN (SELECT message_id FROM messages)");
  }
}
