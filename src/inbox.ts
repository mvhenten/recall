import type { z } from "zod";
import {
  type InboxMessageSchema,
  InboxPostSchema,
  InboxReadOneSchema,
  InboxReadThroughSchema,
  InboxUnreadSchema,
  InboxWaitSchema,
} from "../typespec/generated/schemas";
import { DAY_MS } from "./model";

export const INBOX_RETENTION_MS = 30 * DAY_MS;
export const INBOX_CAPACITY = 1000;
export const INBOX_PAGE_BYTES = 96 * 1024;

export type InboxPost = z.infer<typeof InboxPostSchema>;
export type InboxMessage = z.infer<typeof InboxMessageSchema>;

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

export const parseInboxPost = (input: unknown): InboxResult<InboxPost> => {
  const parsed = InboxPostSchema.safeParse(input);
  if (!parsed.success) return inboxRefusal(400, parsed.error.message);
  const post = parsed.data;
  for (const [key, max] of [
    ["sender", 64],
    ["subject", 160],
    ["body", 4096],
  ] as const) {
    const value = post[key];
    if (typeof value !== "string" || value.trim() === "" || new TextEncoder().encode(value).length > max) {
      return inboxRefusal(400, `${key} must be nonblank and at most ${max} UTF-8 bytes`);
    }
  }
  if (post.link !== undefined) {
    if (typeof post.link !== "string" || new TextEncoder().encode(post.link).length > 2048) {
      return inboxRefusal(400, "link must be an absolute HTTPS URL of at most 2048 UTF-8 bytes");
    }
    const url = URL.parse(post.link);
    if (url === null || url.protocol !== "https:" || !/^https:\/\//i.test(post.link)) {
      return inboxRefusal(400, "link must be an absolute HTTPS URL");
    }
  }
  return { ok: true, value: post };
};

export const parseInboxQuery = (input: unknown): InboxResult<InboxQuery> => {
  const parsed = InboxUnreadSchema.safeParse(input);
  if (!parsed.success) return inboxRefusal(400, parsed.error.message);
  const { after = 0, limit = 10 } = parsed.data;
  return { ok: true, value: { after, limit } };
};

export const parseInboxWait = (input: unknown): InboxResult<InboxWait> => {
  const parsed = InboxWaitSchema.safeParse(input);
  if (!parsed.success) return inboxRefusal(400, parsed.error.message);
  const { after = 0, limit = 10, timeout_seconds = 60 } = parsed.data;
  return { ok: true, value: { after, limit, timeout_seconds } };
};

export const parseInboxRead = (input: unknown): InboxResult<InboxRead> => {
  const one = InboxReadOneSchema.safeParse(input);
  if (one.success) return { ok: true, value: one.data };
  const through = InboxReadThroughSchema.safeParse(input);
  if (through.success) return { ok: true, value: through.data };
  return inboxRefusal(400, "read takes exactly one of positive id or nonnegative up_to, both JSON safe integers");
};
