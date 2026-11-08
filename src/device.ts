import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import type { AccountDb } from "./db";
import { deviceCodes, devices, principals } from "./schema/account";

export const DEVICE_CODE_TTL_MS = 600_000;
export const POLL_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const LAST_USED_RESOLUTION_MS = 3_600_000;

// The name and host the connector row carries. Only hosts are listed, addressed by a message or
// revoked, so a connector never reads as a machine the user owns.
export const CONNECTOR_NAME = "desktop connector";

export interface DeviceCodeLimits {
  perClient: number;
  total: number;
}

export const DEVICE_CODE_LIMITS: DeviceCodeLimits = { perClient: 5, total: 200 };

export type DeviceCodeStatus = "pending" | "approved" | "denied";

export interface DeviceCode {
  userCode: string;
  deviceName: string;
  status: DeviceCodeStatus;
  expiresAt: number;
  intervalS: number;
  lastPolledAt: number;
}

// `name` is unique across the account and `host` is not: a machine signing in twice is named
// core-box and core-box-2, and both say their host is core-box. Everything addressed to a machine
// rather than to one of its logins — a label above all — keys on `host`.
export interface Device {
  deviceId: string;
  name: string;
  host: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface Caller {
  userId: string;
  deviceId: string;
  name: string;
  host: string;
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

// The two limits are counted inside the insert rather than read first, so two requests racing for
// the last free slot cannot both be told they have it. An insert guarded by a count of the table
// it writes is not a shape drizzle's insert builder can take.
export const startDeviceCode = async (
  db: AccountDb,
  deviceName: string,
  clientIp: string,
  limits: DeviceCodeLimits,
  now: number,
): Promise<{ deviceCode: string; userCode: string; expiresAt: number } | null> => {
  const deviceCode = randomToken();
  const userCode = newUserCode();
  const expiresAt = now + DEVICE_CODE_TTL_MS;
  const [, inserted] = await db.batch([
    db.delete(deviceCodes).where(lte(deviceCodes.expiresAt, now)),
    db
      .insert(deviceCodes)
      .select(
        sql`SELECT ${await sha256Hex(deviceCode)}, ${userCode}, ${deviceName}, ${clientIp}, 'pending', '', ${now},
          ${expiresAt}, ${POLL_INTERVAL_S}, ${now}
        WHERE (SELECT count(*) FROM ${deviceCodes} WHERE ${deviceCodes.expiresAt} > ${now}) < ${limits.total}
          AND (SELECT count(*) FROM ${deviceCodes}
               WHERE ${deviceCodes.clientIp} = ${clientIp}
                 AND ${deviceCodes.expiresAt} > ${now}) < ${limits.perClient}`,
      )
      .returning({ userCode: deviceCodes.userCode }),
  ]);
  return inserted.length === 1 ? { deviceCode, userCode, expiresAt } : null;
};

const DEVICE_CODE_FIELDS = {
  userCode: deviceCodes.userCode,
  deviceName: deviceCodes.deviceName,
  status: deviceCodes.status,
  expiresAt: deviceCodes.expiresAt,
  intervalS: deviceCodes.intervalS,
  lastPolledAt: deviceCodes.lastPolledAt,
};

interface DeviceCodeRow {
  userCode: string;
  deviceName: string;
  status: DeviceCodeStatus;
  expiresAt: number;
  intervalS: number;
  lastPolledAt: number;
}

const toDeviceCode = (row: DeviceCodeRow): DeviceCode => ({
  userCode: row.userCode,
  deviceName: row.deviceName,
  status: row.status,
  expiresAt: row.expiresAt,
  intervalS: row.intervalS,
  lastPolledAt: row.lastPolledAt,
});

export const pendingDeviceCode = async (db: AccountDb, userCode: string, now: number): Promise<DeviceCode | null> => {
  const row = await db
    .select(DEVICE_CODE_FIELDS)
    .from(deviceCodes)
    .where(and(eq(deviceCodes.userCode, userCode), eq(deviceCodes.status, "pending"), gt(deviceCodes.expiresAt, now)))
    .get();
  return row === undefined ? null : toDeviceCode(row);
};

export const decideDeviceCode = async (
  db: AccountDb,
  userCode: string,
  decision: "approved" | "denied",
  userId: string,
  now: number,
): Promise<boolean> => {
  const decided = await db
    .update(deviceCodes)
    .set({ status: decision, userId })
    .where(and(eq(deviceCodes.userCode, userCode), eq(deviceCodes.status, "pending"), gt(deviceCodes.expiresAt, now)))
    .returning({ userCode: deviceCodes.userCode })
    .all();
  return decided.length === 1;
};

const suffixed = (name: string, suffix: number): string => `${name}-${suffix}`;

const freeDeviceName = async (db: AccountDb, userId: string, wanted: string): Promise<string> => {
  const results = await db
    .select({ name: devices.name })
    .from(devices)
    .where(and(eq(devices.userId, userId), eq(devices.kind, "host")))
    .all();
  const taken = new Set(results.map((row) => row.name));
  if (!taken.has(wanted)) return wanted;
  let suffix = 2;
  while (taken.has(suffixed(wanted, suffix))) suffix += 1;
  return suffixed(wanted, suffix);
};

export const pollDeviceCode = async (db: AccountDb, deviceCode: string, now: number): Promise<PollOutcome> => {
  const codeHash = await sha256Hex(deviceCode);
  const row = await db
    .select({ ...DEVICE_CODE_FIELDS, userId: deviceCodes.userId })
    .from(deviceCodes)
    .where(eq(deviceCodes.deviceCodeSha256, codeHash))
    .get();
  if (row === undefined) return { ok: false, error: "invalid_grant" };
  const code = toDeviceCode(row);
  const byHash = eq(deviceCodes.deviceCodeSha256, codeHash);
  if (now >= code.expiresAt) {
    await db.delete(deviceCodes).where(byHash).run();
    return { ok: false, error: "expired_token" };
  }
  if (now - code.lastPolledAt < code.intervalS * 1000) {
    await db
      .update(deviceCodes)
      .set({ intervalS: code.intervalS + SLOW_DOWN_STEP_S, lastPolledAt: now })
      .where(byHash)
      .run();
    return { ok: false, error: "slow_down" };
  }
  if (code.status === "pending") {
    await db.update(deviceCodes).set({ lastPolledAt: now }).where(byHash).run();
    return { ok: false, error: "authorization_pending" };
  }
  if (code.status === "denied") {
    await db.delete(deviceCodes).where(byHash).run();
    return { ok: false, error: "access_denied" };
  }
  const accessToken = randomToken();
  const name = await freeDeviceName(db, row.userId, code.deviceName);
  // The login is written out of the approved code row, so the account it lands under is the one
  // that approved it and never one the poller named, and the name is claimed in the same statement
  // that reads the code: two polls racing cannot both take it.
  const [issued] = await db.batch([
    db
      .insert(devices)
      .select(
        sql`SELECT ${crypto.randomUUID()}, ${await sha256Hex(accessToken)}, ${deviceCodes.userId}, ${name},
          ${now}, ${now}, ${code.deviceName}, 'host'
        FROM ${deviceCodes}
        WHERE ${deviceCodes.deviceCodeSha256} = ${codeHash} AND ${deviceCodes.status} = 'approved'
          AND NOT EXISTS (SELECT 1 FROM ${devices}
            WHERE ${devices.userId} = ${deviceCodes.userId} AND ${devices.name} = ${name}
              AND ${devices.kind} = 'host')`,
      )
      .returning({ deviceId: devices.deviceId }),
    db.delete(deviceCodes).where(byHash),
  ]);
  if (issued.length !== 1) return { ok: false, error: "invalid_grant" };
  return { ok: true, accessToken };
};

export const userForEmail = async (db: AccountDb, email: string): Promise<string | null> => {
  const row = await db.select({ userId: principals.userId }).from(principals).where(eq(principals.email, email)).get();
  return row === undefined ? null : row.userId;
};

// The account's first address, which is as precise as a writer can be named: a device token
// carries a user and `principals` maps several emails to one. An account whose addresses have all
// been withdrawn names none, and the empty string is what the row then carries.
export const emailForUser = async (db: AccountDb, userId: string): Promise<string> => {
  const row = await db
    .select({ email: principals.email })
    .from(principals)
    .where(eq(principals.userId, userId))
    .orderBy(asc(principals.email))
    .limit(1)
    .get();
  return row?.email ?? "";
};

export const deviceForToken = async (db: AccountDb, token: string, now: number): Promise<Caller | null> => {
  const row = await db
    .select({
      deviceId: devices.deviceId,
      userId: devices.userId,
      name: devices.name,
      host: devices.host,
      lastUsedAt: devices.lastUsedAt,
    })
    .from(devices)
    .where(and(eq(devices.tokenSha256, await sha256Hex(token)), eq(devices.kind, "host")))
    .get();
  if (row === undefined) return null;
  if (now - row.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
    await db.update(devices).set({ lastUsedAt: now }).where(eq(devices.deviceId, row.deviceId)).run();
  }
  return { userId: row.userId, deviceId: row.deviceId, name: row.name, host: row.host };
};

export const listDevices = async (db: AccountDb, userId: string): Promise<Device[]> =>
  db
    .select({
      deviceId: devices.deviceId,
      name: devices.name,
      host: devices.host,
      createdAt: devices.createdAt,
      lastUsedAt: devices.lastUsedAt,
    })
    .from(devices)
    .where(and(eq(devices.userId, userId), eq(devices.kind, "host")))
    .orderBy(asc(devices.createdAt), asc(devices.deviceId))
    .all();

export const hasDevice = async (db: AccountDb, userId: string, deviceId: string): Promise<boolean> => {
  const row = await db
    .select({ deviceId: devices.deviceId })
    .from(devices)
    .where(and(eq(devices.userId, userId), eq(devices.deviceId, deviceId), eq(devices.kind, "host")))
    .get();
  return row !== undefined;
};

export const revokeDevice = async (db: AccountDb, userId: string, deviceId: string): Promise<boolean> => {
  const revoked = await db
    .delete(devices)
    .where(and(eq(devices.userId, userId), eq(devices.deviceId, deviceId), eq(devices.kind, "host")))
    .returning({ deviceId: devices.deviceId })
    .all();
  return revoked.length === 1;
};

// The row the MCP endpoint acts as. Its token column holds the digest of a string no issued token
// can hash to, so the connector is reachable through Access alone and never through a bearer token.
export const connectorDevice = async (db: AccountDb, userId: string, now: number): Promise<Caller> => {
  const row = await db
    .insert(devices)
    .values({
      deviceId: crypto.randomUUID(),
      tokenSha256: await sha256Hex(`connector:${userId}`),
      userId,
      name: CONNECTOR_NAME,
      host: CONNECTOR_NAME,
      kind: "connector",
      createdAt: now,
      lastUsedAt: now,
    })
    .onConflictDoUpdate({ target: devices.tokenSha256, set: { lastUsedAt: sql`excluded.last_used_at` } })
    .returning({ deviceId: devices.deviceId })
    .get();
  if (row === undefined) throw new Error(`no connector device for ${userId}`);
  return { userId, deviceId: row.deviceId, name: CONNECTOR_NAME, host: CONNECTOR_NAME };
};
