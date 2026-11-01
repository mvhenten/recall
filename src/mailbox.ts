import { DurableObject } from "cloudflare:workers";
import type { Parsed } from "./model";

export const MESSAGE_TTL_MS = 259_200_000;
export const MAX_QUEUED_MESSAGES = 1_000;
export const MAX_BODY_BYTES = 32_768;

export interface Message {
  messageId: string;
  toDeviceId: string;
  fromDeviceId: string;
  body: string;
  createdAt: number;
  expiresAt: number;
}

export interface SendInput {
  toDeviceId: string;
  body: string;
}

interface MessageRow extends Record<string, string | number> {
  message_id: string;
  to_device_id: string;
  from_device_id: string;
  body: string;
  created_at: number;
  expires_at: number;
}

const toMessage = (row: MessageRow): Message => ({
  messageId: row.message_id,
  toDeviceId: row.to_device_id,
  fromDeviceId: row.from_device_id,
  body: row.body,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

export const parseSend = (input: unknown): Parsed<SendInput> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const { toDeviceId, body } = input as Record<string, unknown>;
  if (typeof toDeviceId !== "string" || toDeviceId.length < 1) {
    return { ok: false, error: "toDeviceId must be the id of a device on this account; see GET /v1/devices" };
  }
  if (typeof body !== "string" || body.length < 1) return { ok: false, error: "body must hold at least one character" };
  return { ok: true, value: { toDeviceId, body } };
};

export class Mailbox extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
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
  }

  enqueue(input: SendInput, fromDeviceId: string, now: number): Message | null {
    this.expire(now);
    const { queued } = this.sql.exec<{ queued: number }>("SELECT count(*) AS queued FROM messages").one();
    if (queued >= MAX_QUEUED_MESSAGES) return null;
    const message: Message = {
      messageId: crypto.randomUUID(),
      toDeviceId: input.toDeviceId,
      fromDeviceId,
      body: input.body,
      createdAt: now,
      expiresAt: now + MESSAGE_TTL_MS,
    };
    this.sql.exec(
      `INSERT INTO messages (message_id, to_device_id, from_device_id, body, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      message.messageId,
      message.toDeviceId,
      message.fromDeviceId,
      message.body,
      message.createdAt,
      message.expiresAt,
    );
    return message;
  }

  list(toDeviceId: string, now: number): Message[] {
    this.expire(now);
    return this.sql
      .exec<MessageRow>(
        `SELECT message_id, to_device_id, from_device_id, body, created_at, expires_at FROM messages
         WHERE to_device_id = ? ORDER BY created_at, message_id`,
        toDeviceId,
      )
      .toArray()
      .map(toMessage);
  }

  ack(toDeviceId: string, messageId: string, now: number): boolean {
    this.expire(now);
    return (
      this.sql.exec("DELETE FROM messages WHERE to_device_id = ? AND message_id = ?", toDeviceId, messageId)
        .rowsWritten > 0
    );
  }

  private expire(now: number): void {
    this.sql.exec("DELETE FROM messages WHERE expires_at <= ?", now);
  }
}
