import { DAY_MS, fail, type Parsed, parseSessionId } from "./model";

// How long a board message waits. Past this nobody reads it, so a post nobody ever booted into
// cannot haunt the fleet: the pickup and the listing both read within the window, and a post
// sweeps what has fallen out of it.
export const BOARD_DAYS = 7;
export const BOARD_WINDOW_MS = BOARD_DAYS * DAY_MS;

// How many messages one pickup takes. A session start reads what it took as injected context, so
// a fleet that posted all week must not land on one boot; the rest stay on the board for the next
// session, which is the paradigm working rather than a loss.
export const MAX_PICKUP = 10;

export const boardScopes = ["fleet", "host", "session"] as const;
export type BoardScope = (typeof boardScopes)[number];

// Where a message is addressed. `target` is the account for the fleet, the device id for a host and
// the session id for a session, so a reader's three addresses are three pairs and the lookup over
// them is one predicate.
export interface BoardAddress {
  scope: BoardScope;
  target: string;
}

// The address as a poster states it, before the service knows whose account it is. The fleet names
// no target because the fleet is the account, which the caller's token is what settles.
export type PostedAddress =
  | { scope: "fleet" }
  | { scope: "host"; deviceId: string }
  | { scope: "session"; sessionId: string };

// `fromSessionId` is the session the post is running inside, which the service turns into the
// handle the board prints over the body. It is empty where the poster cannot say which session
// asked, and the board then names its host alone, exactly as a bus message does.
export interface BoardPost {
  address: PostedAddress;
  fromSessionId: string;
  body: string;
}

export const addressOf = (posted: PostedAddress, userId: string): BoardAddress => {
  if (posted.scope === "fleet") return { scope: "fleet", target: userId };
  if (posted.scope === "host") return { scope: "host", target: posted.deviceId };
  return { scope: "session", target: posted.sessionId };
};

// One row of `board_messages`. `fromHost` and `fromName` are resolved where the message is posted
// and ride with it, exactly as a bus message's do, so a session reading one off the board looks
// nothing up.
export interface BoardMessage {
  messageId: string;
  scope: BoardScope;
  target: string;
  fromDeviceId: string;
  fromHost: string;
  fromName: string;
  body: string;
  createdAt: number;
  expiresAt: number;
}

export interface BoardTaker {
  sessionId: string;
  deviceId: string;
  host: string;
  pickedUpAt: number;
}

// A message as the board shows it. One still waiting carries no taker at all, rather than a row of
// fields that are empty until somebody picks it up.
export type BoardEntry =
  | { state: "waiting"; message: BoardMessage }
  | { state: "taken"; message: BoardMessage; takenBy: BoardTaker };

export interface BoardInput {
  userId: string;
  messageId: string;
  address: BoardAddress;
  fromDeviceId: string;
  fromHost: string;
  fromName: string;
  body: string;
  createdAt: number;
}

const parseAddress = (input: Record<string, unknown>): Parsed<PostedAddress> => {
  const { scope, deviceId, sessionId } = input;
  if (scope === "fleet") return { ok: true, value: { scope: "fleet" } };
  if (scope === "host") {
    if (typeof deviceId !== "string" || deviceId.length < 1) {
      return fail("deviceId must be the id of a device on this account; see GET /v1/devices");
    }
    return { ok: true, value: { scope: "host", deviceId } };
  }
  if (scope !== "session") {
    return fail(
      'scope must be "fleet" for every host on the account, "host" for one host, or "session" for one session',
    );
  }
  if (typeof sessionId !== "string") return fail("sessionId must be the id of a session on this account");
  const parsed = parseSessionId(sessionId);
  return parsed.ok ? { ok: true, value: { scope: "session", sessionId: parsed.value } } : parsed;
};

export const parsePost = (input: unknown): Parsed<BoardPost> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("body must be a JSON object");
  const fields = input as Record<string, unknown>;
  if (typeof fields.body !== "string" || fields.body.trim().length < 1) {
    return fail("body must hold at least one character");
  }
  const address = parseAddress(fields);
  if (!address.ok) return address;
  const { fromSessionId } = fields;
  if (fromSessionId !== undefined && fromSessionId !== "") {
    if (typeof fromSessionId !== "string") return fail("fromSessionId must be the id of a session on the posting host");
    const from = parseSessionId(fromSessionId);
    if (!from.ok) return from;
    return { ok: true, value: { address: address.value, fromSessionId: from.value, body: fields.body } };
  }
  return { ok: true, value: { address: address.value, fromSessionId: "", body: fields.body } };
};

// Who the board says posted a message, in the one place that decides it. A host with a label reads
// as its label, and a post that could not name the session it came from reads as its host alone.
export const posterOf = (message: BoardMessage): string => {
  const from = message.fromHost === "" ? message.fromDeviceId : message.fromHost;
  return message.fromName === "" ? from : `${from}/${message.fromName}`;
};

// What a board message is addressed to, as a reader of the dashboard reads it.
export const addressText = (message: BoardMessage): string =>
  message.scope === "fleet" ? "the fleet" : `${message.scope} ${message.target}`;
