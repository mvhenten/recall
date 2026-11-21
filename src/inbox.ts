import { DAY_MS } from "./model";

export const INBOX_RETENTION_MS = 30 * DAY_MS;
export const INBOX_CAPACITY = 1000;
export const INBOX_PAGE_BYTES = 96 * 1024;

export interface InboxPost {
  sender: string;
  subject: string;
  body: string;
  link?: string;
}

export interface InboxMessage {
  id: number;
  sender: string;
  subject: string;
  body: string;
  link: string | null;
  createdAt: number;
  expiresAt: number;
  readAt: number | null;
}

export interface InboxQuery {
  after: number;
  limit: number;
}

export interface InboxWait extends InboxQuery {
  timeout_seconds: number;
}

export type InboxRead = { id: number; up_to?: never } | { up_to: number; id?: never };
export interface InboxPage {
  messages: InboxMessage[];
  nextCursor: number;
}

export type InboxResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 429; error: string };
export const inboxRefusal = (status: 400 | 404 | 429, error: string): InboxResult<never> => ({
  ok: false,
  status,
  error,
});

const object = (input: unknown, keys: string[]): input is Record<string, unknown> =>
  typeof input === "object" &&
  input !== null &&
  !Array.isArray(input) &&
  Object.keys(input).every((key) => keys.includes(key));

export const inboxInteger = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

export const parseInboxPost = (input: unknown): InboxResult<InboxPost> => {
  if (!object(input, ["sender", "subject", "body", "link"])) return inboxRefusal(400, "post must be a closed object");
  for (const [key, max] of [
    ["sender", 64],
    ["subject", 160],
    ["body", 4096],
  ] as const) {
    const value = input[key];
    if (typeof value !== "string" || value.trim() === "" || new TextEncoder().encode(value).length > max) {
      return inboxRefusal(400, `${key} must be nonblank and at most ${max} UTF-8 bytes`);
    }
  }
  if (input.link !== undefined) {
    if (typeof input.link !== "string" || new TextEncoder().encode(input.link).length > 2048) {
      return inboxRefusal(400, "link must be an absolute HTTPS URL of at most 2048 UTF-8 bytes");
    }
    const url = URL.parse(input.link);
    if (url === null || url.protocol !== "https:" || !/^https:\/\//i.test(input.link)) {
      return inboxRefusal(400, "link must be an absolute HTTPS URL");
    }
  }
  return { ok: true, value: input as unknown as InboxPost };
};

export const parseInboxQuery = (input: unknown): InboxResult<InboxQuery> => {
  if (!object(input, ["after", "limit"])) return inboxRefusal(400, "unread must be a closed object");
  const { after = 0, limit = 10 } = input;
  if (!inboxInteger(after, 0)) return inboxRefusal(400, "after must be a nonnegative JSON safe integer");
  if (!inboxInteger(limit, 1, 20)) return inboxRefusal(400, "limit must be an integer from 1 to 20");
  return { ok: true, value: { after, limit } };
};

export const parseInboxWait = (input: unknown): InboxResult<InboxWait> => {
  if (!object(input, ["after", "limit", "timeout_seconds"])) return inboxRefusal(400, "wait must be a closed object");
  const { timeout_seconds = 60, ...query } = input;
  if (!inboxInteger(timeout_seconds, 0, 120))
    return inboxRefusal(400, "timeout_seconds must be an integer from 0 to 120");
  const parsed = parseInboxQuery(query);
  return parsed.ok ? { ok: true, value: { ...parsed.value, timeout_seconds } } : parsed;
};

export const parseInboxRead = (input: unknown): InboxResult<InboxRead> => {
  if (!object(input, ["id", "up_to"]) || Object.keys(input).length !== 1) {
    return inboxRefusal(400, "read takes exactly one of id or up_to");
  }
  if ("id" in input && inboxInteger(input.id, 1)) return { ok: true, value: { id: input.id } };
  if ("up_to" in input && inboxInteger(input.up_to, 0)) return { ok: true, value: { up_to: input.up_to } };
  return inboxRefusal(400, "id must be positive; up_to must be nonnegative; both must be JSON safe integers");
};
