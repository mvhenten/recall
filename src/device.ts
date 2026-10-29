export const DEVICE_CODE_TTL_MS = 600_000;
export const POLL_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const PRUNE_AFTER_MS = 3_600_000;

export type DeviceCodeStatus = "pending" | "approved" | "denied";

export interface DeviceCode {
  userCode: string;
  deviceName: string;
  status: DeviceCodeStatus;
  expiresAt: number;
  intervalS: number;
  lastPolledAt: number;
}

export interface Device {
  deviceId: string;
  name: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface Caller {
  userId: string;
  deviceId: string | null;
}

export type PollOutcome =
  | { ok: true; accessToken: string }
  | {
      ok: false;
      error: "invalid_grant" | "expired_token" | "slow_down" | "authorization_pending" | "access_denied";
    };

const encoder = new TextEncoder();

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

export const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const newUserCode = (): string => {
  let code = "";
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 240 && code.length < USER_CODE_LENGTH) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
  }
  return code;
};

export const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export const parseUserCode = (input: string): string | null => {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== USER_CODE_LENGTH) return null;
  return [...code].every((char) => USER_CODE_ALPHABET.includes(char)) ? code : null;
};

export const sameSecret = (a: string, b: string): boolean => {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
};

export const startDeviceCode = async (
  db: D1Database,
  deviceName: string,
  now: number,
): Promise<{ deviceCode: string; userCode: string; expiresAt: number }> => {
  const deviceCode = randomToken();
  const userCode = newUserCode();
  const expiresAt = now + DEVICE_CODE_TTL_MS;
  await db.batch([
    db.prepare("DELETE FROM device_codes WHERE expires_at < ?").bind(now - PRUNE_AFTER_MS),
    db
      .prepare(
        `INSERT INTO device_codes (device_code_sha256, user_code, device_name, status, user_id, created_at, expires_at, interval_s, last_polled_at)
         VALUES (?, ?, ?, 'pending', '', ?, ?, ?, ?)`,
      )
      .bind(await sha256Hex(deviceCode), userCode, deviceName, now, expiresAt, POLL_INTERVAL_S, now),
  ]);
  return { deviceCode, userCode, expiresAt };
};

interface DeviceCodeRow {
  user_code: string;
  device_name: string;
  status: DeviceCodeStatus;
  expires_at: number;
  interval_s: number;
  last_polled_at: number;
}

const toDeviceCode = (row: DeviceCodeRow): DeviceCode => ({
  userCode: row.user_code,
  deviceName: row.device_name,
  status: row.status,
  expiresAt: row.expires_at,
  intervalS: row.interval_s,
  lastPolledAt: row.last_polled_at,
});

export const pendingDeviceCode = async (db: D1Database, userCode: string, now: number): Promise<DeviceCode | null> => {
  const row = await db
    .prepare(
      `SELECT user_code, device_name, status, expires_at, interval_s, last_polled_at FROM device_codes
       WHERE user_code = ? AND status = 'pending' AND expires_at > ?`,
    )
    .bind(userCode, now)
    .first<DeviceCodeRow>();
  return row ? toDeviceCode(row) : null;
};

export const decideDeviceCode = async (
  db: D1Database,
  userCode: string,
  decision: "approved" | "denied",
  userId: string,
  now: number,
): Promise<boolean> => {
  const result = await db
    .prepare(
      `UPDATE device_codes SET status = ?, user_id = ?
       WHERE user_code = ? AND status = 'pending' AND expires_at > ?`,
    )
    .bind(decision, userId, userCode, now)
    .run();
  return result.meta.changes === 1;
};

export const pollDeviceCode = async (db: D1Database, deviceCode: string, now: number): Promise<PollOutcome> => {
  const codeHash = await sha256Hex(deviceCode);
  const row = await db
    .prepare(
      `SELECT user_code, device_name, status, expires_at, interval_s, last_polled_at FROM device_codes
       WHERE device_code_sha256 = ?`,
    )
    .bind(codeHash)
    .first<DeviceCodeRow>();
  if (!row) return { ok: false, error: "invalid_grant" };
  const code = toDeviceCode(row);
  if (now >= code.expiresAt) return { ok: false, error: "expired_token" };
  if (now - code.lastPolledAt < code.intervalS * 1000) {
    await db
      .prepare("UPDATE device_codes SET interval_s = ?, last_polled_at = ? WHERE device_code_sha256 = ?")
      .bind(code.intervalS + SLOW_DOWN_STEP_S, now, codeHash)
      .run();
    return { ok: false, error: "slow_down" };
  }
  if (code.status === "pending") {
    await db
      .prepare("UPDATE device_codes SET last_polled_at = ? WHERE device_code_sha256 = ?")
      .bind(now, codeHash)
      .run();
    return { ok: false, error: "authorization_pending" };
  }
  if (code.status === "denied") {
    await db.prepare("DELETE FROM device_codes WHERE device_code_sha256 = ?").bind(codeHash).run();
    return { ok: false, error: "access_denied" };
  }
  const accessToken = randomToken();
  const [issued] = await db.batch([
    db
      .prepare(
        `INSERT INTO devices (device_id, token_sha256, user_id, name, created_at, last_used_at)
         SELECT ?, ?, user_id, device_name, ?, ? FROM device_codes
         WHERE device_code_sha256 = ? AND status = 'approved'`,
      )
      .bind(crypto.randomUUID(), await sha256Hex(accessToken), now, now, codeHash),
    db.prepare("DELETE FROM device_codes WHERE device_code_sha256 = ?").bind(codeHash),
  ]);
  if (issued?.meta.changes !== 1) return { ok: false, error: "invalid_grant" };
  return { ok: true, accessToken };
};

export const userForEmail = async (db: D1Database, email: string): Promise<string> => {
  const row = await db
    .prepare(
      `INSERT INTO principals (email, user_id) VALUES (?, ?)
       ON CONFLICT (email) DO UPDATE SET email = excluded.email
       RETURNING user_id`,
    )
    .bind(email, crypto.randomUUID())
    .first<{ user_id: string }>();
  if (!row) throw new Error(`no principal row for ${email} after the upsert`);
  return row.user_id;
};

export const deviceForToken = async (db: D1Database, token: string, now: number): Promise<Caller | null> => {
  const row = await db
    .prepare("UPDATE devices SET last_used_at = ? WHERE token_sha256 = ? RETURNING device_id, user_id")
    .bind(now, await sha256Hex(token))
    .first<{ device_id: string; user_id: string }>();
  return row ? { userId: row.user_id, deviceId: row.device_id } : null;
};

export const userForServiceToken = async (
  db: D1Database,
  clientId: string,
  clientSecret: string,
): Promise<string | null> => {
  const row = await db
    .prepare("SELECT user_id FROM service_tokens WHERE client_id = ? AND secret_sha256 = ? AND secret_sha256 != ''")
    .bind(clientId, await sha256Hex(clientSecret))
    .first<{ user_id: string }>();
  return row ? row.user_id : null;
};

export const listDevices = async (db: D1Database, userId: string): Promise<Device[]> => {
  const { results } = await db
    .prepare(
      "SELECT device_id, name, created_at, last_used_at FROM devices WHERE user_id = ? ORDER BY created_at, device_id",
    )
    .bind(userId)
    .all<{ device_id: string; name: string; created_at: number; last_used_at: number }>();
  return results.map((row) => ({
    deviceId: row.device_id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
};

export const revokeDevice = async (db: D1Database, userId: string, deviceId: string): Promise<boolean> => {
  const result = await db
    .prepare("DELETE FROM devices WHERE user_id = ? AND device_id = ?")
    .bind(userId, deviceId)
    .run();
  return result.meta.changes === 1;
};
