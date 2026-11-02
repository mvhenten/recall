import { DurableObject } from "cloudflare:workers";
import { type Caller, listDevices } from "./device";
import { type Parsed, parseSessionId } from "./model";

export const MESSAGE_TTL_MS = 259_200_000;
export const MAX_QUEUED_MESSAGES = 1_000;
export const MAX_BODY_BYTES = 32_768;
export const SWEEP_INTERVAL_MS = 900_000;

export const DEVICE_HEADER = "x-recall-device-id";
export const NOW_HEADER = "x-recall-now";

export const CLOSE_BAD_FRAME = 4000;
export const CLOSE_REVOKED = 4001;

// `toSessionId` is the one session the message is addressed to, or empty for every session the
// host has registered.
export interface Message {
  messageId: string;
  toDeviceId: string;
  toSessionId: string;
  fromDeviceId: string;
  body: string;
  createdAt: number;
  expiresAt: number;
}

export interface SendInput {
  toDeviceId: string;
  toSessionId: string;
  body: string;
}

export interface MessageFrame {
  type: "message";
  message: Message;
}

export interface AckFrame {
  type: "ack";
  messageId: string;
}

export interface MailboxEnv {
  DB: D1Database;
}

interface MessageRow extends Record<string, string | number> {
  message_id: string;
  to_device_id: string;
  to_session_id: string;
  from_device_id: string;
  body: string;
  created_at: number;
  expires_at: number;
}

interface Attachment {
  deviceId: string;
}

const toMessage = (row: MessageRow): Message => ({
  messageId: row.message_id,
  toDeviceId: row.to_device_id,
  toSessionId: row.to_session_id,
  fromDeviceId: row.from_device_id,
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

export const parseSend = (input: unknown): Parsed<SendInput> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const { toDeviceId, toSessionId, body } = input as Record<string, unknown>;
  if (typeof toDeviceId !== "string" || toDeviceId.length < 1) {
    return { ok: false, error: "toDeviceId must be the id of a device on this account; see GET /v1/devices" };
  }
  if (typeof body !== "string" || body.length < 1) return { ok: false, error: "body must hold at least one character" };
  const session = parseToSessionId(toSessionId);
  if (!session.ok) return session;
  return { ok: true, value: { toDeviceId, toSessionId: session.value, body } };
};

const readJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const parseAck = (raw: string): string | null => {
  const frame = readJson(raw);
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return null;
  const { type, messageId } = frame as Record<string, unknown>;
  if (type !== "ack" || typeof messageId !== "string" || messageId.length < 1) return null;
  return messageId;
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

  constructor(ctx: DurableObjectState, env: MailboxEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (
         message_id TEXT PRIMARY KEY,
         to_device_id TEXT NOT NULL,
         from_device_id TEXT NOT NULL,
         body TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    );
    this.sql.exec("CREATE INDEX IF NOT EXISTS messages_by_device ON messages (to_device_id, created_at, message_id)");
    // A mailbox older than per-session addressing has no to_session_id, and its queued messages are
    // all for the whole host. `PRAGMA user_version` is one of the pragmas a Durable Object refuses,
    // so the column itself is the version marker.
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(messages)").toArray();
    if (!columns.some((column) => column.name === "to_session_id")) {
      this.sql.exec("ALTER TABLE messages ADD COLUMN to_session_id TEXT NOT NULL DEFAULT ''");
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
    for (const message of this.list(deviceId, now)) pair[1].send(messageFrame(message));
    await this.scheduleSweep();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket: WebSocket, received: string | ArrayBuffer): void {
    const deviceId = deviceOf(socket);
    const messageId = typeof received === "string" ? parseAck(received) : null;
    if (deviceId === null || messageId === null) {
      socket.close(CLOSE_BAD_FRAME, 'every frame must be {"type":"ack","messageId":"<id>"}');
      return;
    }
    this.remove(deviceId, messageId);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.expire(now);
    const live = await this.liveDevices();
    this.reap(live);
    for (const socket of this.ctx.getWebSockets()) {
      const deviceId = deviceOf(socket);
      if (deviceId === null || !live.has(deviceId)) {
        socket.close(CLOSE_REVOKED, "this device is no longer signed in; run recall login");
      }
    }
    await this.scheduleSweep();
  }

  async enqueue(input: SendInput, from: Caller, now: number): Promise<Message | null> {
    this.expire(now);
    if (this.queued() >= MAX_QUEUED_MESSAGES) return null;
    const message: Message = {
      messageId: crypto.randomUUID(),
      toDeviceId: input.toDeviceId,
      toSessionId: input.toSessionId,
      fromDeviceId: from.deviceId,
      body: input.body,
      createdAt: now,
      expiresAt: now + MESSAGE_TTL_MS,
    };
    this.sql.exec(
      `INSERT INTO messages (message_id, to_device_id, to_session_id, from_device_id, body, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      message.messageId,
      message.toDeviceId,
      message.toSessionId,
      message.fromDeviceId,
      message.body,
      message.createdAt,
      message.expiresAt,
    );
    this.push(message);
    await this.scheduleSweep();
    return message;
  }

  list(toDeviceId: string, now: number): Message[] {
    this.expire(now);
    return this.sql
      .exec<MessageRow>(
        `SELECT message_id, to_device_id, to_session_id, from_device_id, body, created_at, expires_at FROM messages
         WHERE to_device_id = ? ORDER BY created_at, rowid`,
        toDeviceId,
      )
      .toArray()
      .map(toMessage);
  }

  private remove(toDeviceId: string, messageId: string): boolean {
    return (
      this.sql.exec("DELETE FROM messages WHERE to_device_id = ? AND message_id = ?", toDeviceId, messageId)
        .rowsWritten > 0
    );
  }

  private push(message: Message): void {
    const frame = messageFrame(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (deviceOf(socket) === message.toDeviceId) socket.send(frame);
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
      if (!live.has(target.to_device_id)) {
        this.sql.exec("DELETE FROM messages WHERE to_device_id = ?", target.to_device_id);
      }
    }
  }

  private queued(): number {
    return this.sql.exec<{ queued: number }>("SELECT count(*) AS queued FROM messages").one().queued;
  }

  private async scheduleSweep(): Promise<void> {
    if (this.queued() === 0 && this.ctx.getWebSockets().length === 0) return;
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  private expire(now: number): void {
    this.sql.exec("DELETE FROM messages WHERE expires_at <= ?", now);
  }
}
