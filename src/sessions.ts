import type { Caller } from "./device";
import type { Parsed } from "./model";

// A session nothing has refreshed for this long is gone: its host died before the SessionEnd hook
// could tombstone it, and no one else ever will. A tombstone itself is swept far sooner, so a
// listing shows a session that has just finished and then stops showing it.
export const SESSION_TTL_MS = 86_400_000;
export const TOMBSTONE_TTL_MS = 900_000;
export const MAX_FOCUS_CHARS = 200;
export const MAX_TEXT_CHARS = 500;
export const MAX_PROMPTS = 1_000_000;

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?([+-]\d{2}:\d{2}|Z)$/;
const MODES = ["interactive", "headless", ""];

export interface Focus {
  first: string;
  latest: string;
}

export interface SessionInput {
  host: string;
  cwd: string;
  repo: string;
  branch: string;
  commit: string;
  startedAt: string;
  lastActivityAt: string;
  prompts: number;
  focus: Focus;
  mode: string;
  permissionMode: string;
  pid: number;
}

export interface Session extends SessionInput {
  sessionId: string;
  name: string;
  deviceId: string;
  endedAt: string;
  current: boolean;
}

interface SessionRow {
  session_id: string;
  name: string;
  device_id: string;
  host: string;
  cwd: string;
  repo: string;
  branch: string;
  commit_subject: string;
  started_at: string;
  last_activity_at: string;
  ended_at: string;
  prompts: number;
  focus_first: string;
  focus_latest: string;
  mode: string;
  permission_mode: string;
  pid: number;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));

export const parseSessionId = (value: string): Parsed<string> =>
  SESSION_ID.test(value) ? { ok: true, value } : fail("the session id may hold 1 to 100 letters, digits, - and _");

const parseFocus = (value: unknown): Parsed<Focus> => {
  if (!isRecord(value) || !isText(value.first, MAX_FOCUS_CHARS) || !isText(value.latest, MAX_FOCUS_CHARS)) {
    return fail(`focus must be {first, latest}, each a string of at most ${MAX_FOCUS_CHARS} characters`);
  }
  return { ok: true, value: { first: value.first, latest: value.latest } };
};

export const parseSession = (body: unknown): Parsed<SessionInput> => {
  if (!isRecord(body)) return fail("body must be a JSON object");
  const { host, cwd, repo, branch, commit, startedAt, lastActivityAt, prompts, mode, permissionMode, pid } = body;
  if (typeof host !== "string" || host.length < 1 || host.length > MAX_TEXT_CHARS) {
    return fail(`host must hold 1 to ${MAX_TEXT_CHARS} characters`);
  }
  const text = (field: string): { ok: false; error: string } =>
    fail(`${field} must be a string of at most ${MAX_TEXT_CHARS} characters, empty when it does not apply`);
  if (!isText(cwd, MAX_TEXT_CHARS)) return text("cwd");
  if (!isText(repo, MAX_TEXT_CHARS)) return text("repo");
  if (!isText(branch, MAX_TEXT_CHARS)) return text("branch");
  if (!isText(commit, MAX_TEXT_CHARS)) return text("commit");
  if (!isText(permissionMode, MAX_TEXT_CHARS)) return text("permissionMode");
  if (!isTimestamp(startedAt) || !isTimestamp(lastActivityAt)) {
    return fail("startedAt and lastActivityAt must be ISO 8601 timestamps with an offset");
  }
  if (typeof prompts !== "number" || !Number.isInteger(prompts) || prompts < 0 || prompts > MAX_PROMPTS) {
    return fail(`prompts must be a whole number from 0 to ${MAX_PROMPTS}`);
  }
  if (typeof mode !== "string" || !MODES.includes(mode)) {
    return fail("mode must be interactive, headless, or empty when the host cannot tell");
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 0) return fail("pid must be a whole number");
  const focus = parseFocus(body.focus);
  if (!focus.ok) return focus;
  return {
    ok: true,
    value: {
      host,
      cwd,
      repo,
      branch,
      commit,
      startedAt,
      lastActivityAt,
      prompts,
      focus: focus.value,
      mode,
      permissionMode,
      pid,
    },
  };
};

const toSession = (row: SessionRow, caller: Caller): Session => ({
  sessionId: row.session_id,
  name: row.name,
  deviceId: row.device_id,
  host: row.host,
  cwd: row.cwd,
  repo: row.repo,
  branch: row.branch,
  commit: row.commit_subject,
  startedAt: row.started_at,
  lastActivityAt: row.last_activity_at,
  endedAt: row.ended_at,
  prompts: row.prompts,
  focus: { first: row.focus_first, latest: row.focus_latest },
  mode: row.mode,
  permissionMode: row.permission_mode,
  pid: row.pid,
  current: row.device_id === caller.deviceId,
});

// An offset is part of every stored timestamp, so comparisons go through the epoch rather than the
// text: two hosts in different zones would otherwise sort by the wall clock they happen to keep.
const epoch = (column: string): string => `CAST(strftime('%s', ${column}) AS INTEGER)`;

const SELECT = `SELECT s.session_id, COALESCE(d.name, '') AS name, s.device_id, s.host, s.cwd, s.repo, s.branch,
    s.commit_subject, s.started_at, s.last_activity_at, s.ended_at, s.prompts, s.focus_first, s.focus_latest,
    s.mode, s.permission_mode, s.pid
  FROM sessions s LEFT JOIN devices d ON d.device_id = s.device_id AND d.user_id = s.user_id`;

const expire = (db: D1Database, now: number): D1PreparedStatement =>
  db
    .prepare(
      `DELETE FROM sessions
       WHERE ${epoch("last_activity_at")} <= ?1
          OR (ended_at <> '' AND ${epoch("ended_at")} <= ?2)`,
    )
    .bind(Math.floor((now - SESSION_TTL_MS) / 1000), Math.floor((now - TOMBSTONE_TTL_MS) / 1000));

export const putSession = async (
  db: D1Database,
  caller: Caller,
  sessionId: string,
  input: SessionInput,
  now: number,
): Promise<Session> => {
  await db.batch([
    expire(db, now),
    db
      .prepare(
        `INSERT INTO sessions (user_id, session_id, device_id, host, cwd, repo, branch, commit_subject,
           started_at, last_activity_at, ended_at, prompts, focus_first, focus_latest, mode, permission_mode, pid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '', ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT (user_id, session_id) DO UPDATE SET
           device_id = excluded.device_id, host = excluded.host, cwd = excluded.cwd, repo = excluded.repo,
           branch = excluded.branch, commit_subject = excluded.commit_subject, started_at = excluded.started_at,
           last_activity_at = excluded.last_activity_at, ended_at = '', prompts = excluded.prompts,
           focus_first = excluded.focus_first, focus_latest = excluded.focus_latest, mode = excluded.mode,
           permission_mode = excluded.permission_mode, pid = excluded.pid`,
      )
      .bind(
        caller.userId,
        sessionId,
        caller.deviceId,
        input.host,
        input.cwd,
        input.repo,
        input.branch,
        input.commit,
        input.startedAt,
        input.lastActivityAt,
        input.prompts,
        input.focus.first,
        input.focus.latest,
        input.mode,
        input.permissionMode,
        input.pid,
      ),
  ]);
  const saved = await getSession(db, caller, sessionId);
  if (!saved) throw new Error(`session ${sessionId} vanished right after it was synced`);
  return saved;
};

export const getSession = async (db: D1Database, caller: Caller, sessionId: string): Promise<Session | null> => {
  const row = await db
    .prepare(`${SELECT} WHERE s.user_id = ? AND s.session_id = ?`)
    .bind(caller.userId, sessionId)
    .first<SessionRow>();
  return row ? toSession(row, caller) : null;
};

// SessionEnd leaves a tombstone rather than removing the row, so the other hosts see the session
// end instead of watching it disappear between two listings.
export const endSession = async (
  db: D1Database,
  userId: string,
  sessionId: string,
  endedAt: string,
): Promise<boolean> => {
  const result = await db
    .prepare("UPDATE sessions SET ended_at = ?1 WHERE user_id = ?2 AND session_id = ?3 AND ended_at = ''")
    .bind(endedAt, userId, sessionId)
    .run();
  return result.meta.changes === 1;
};

export const listSessions = async (db: D1Database, caller: Caller, now: number): Promise<Session[]> => {
  const [, listed] = await db.batch<SessionRow>([
    expire(db, now),
    db
      .prepare(`${SELECT} WHERE s.user_id = ? ORDER BY ${epoch("s.last_activity_at")} DESC, s.session_id`)
      .bind(caller.userId),
  ]);
  return (listed?.results ?? []).map((row) => toSession(row, caller));
};
