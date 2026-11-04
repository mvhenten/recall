import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_WINDOW_BYTES } from "../src/dashboard";
import { MAX_BODY_BYTES, type Mailbox, type Message } from "../src/mailbox";
import { type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

const ORIGIN = "https://recall.test";

interface Owner {
  userId: string;
  email: string;
  assertion: string;
  laptop: Client;
}

const owner = async (h: Harness): Promise<Owner> => {
  const userId = `user-${crypto.randomUUID()}`;
  const email = await h.invite(`${userId}@example.com`, userId);
  return { userId, email, assertion: await h.assertionFor(email), laptop: h.clientWithToken(await h.login(email)) };
};

const open = (h: Harness, path: string, assertion: string | null, cookie = ""): Promise<Response> =>
  h.send(path, {
    headers: {
      ...(assertion === null ? {} : { "cf-access-jwt-assertion": assertion }),
      ...(cookie === "" ? {} : { cookie }),
    },
  });

const cookieFrom = (response: Response): string => response.headers.getSetCookie().join("; ");

const read = async (h: Harness, path: string, assertion: string): Promise<string> => {
  const response = await open(h, path, assertion);
  expect(response.status).toBe(200);
  return response.text();
};

// A transcript of prompts, each long enough that a hundred of them run past two windows and no
// two of them the same length, so no window boundary can land on an entry edge by arithmetic. The
// index is in the prose, so a window says which stretch of the file it was read from.
const entry = (index: number, pad = 1_200 + ((index * 137) % 1_600)): string =>
  JSON.stringify({
    type: "user",
    origin: { kind: "human" },
    timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    message: { content: `prompt ${String(index).padStart(3, "0")} ${"x".repeat(pad)}` },
  });

const transcriptOf = (entries: number): string =>
  `${Array.from({ length: entries }, (_, index) => entry(index)).join("\n")}\n`;

const laterLink = (html: string): string | null => {
  const found = /<a href="([^"]+)">Later →<\/a>/.exec(html)?.[1];
  return found === undefined ? null : found.replaceAll("&amp;", "&");
};

const earlierLink = (html: string): string | null => {
  const found = /<a href="([^"]+)">← Earlier<\/a>/.exec(html)?.[1];
  return found === undefined ? null : found.replaceAll("&amp;", "&");
};

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

const archivedBody = async (h: Harness, client: Client, sessionId: string, body: string, at = 0): Promise<number> => {
  const now = h.now();
  expect((await client.sync(sessionId, { startedAt: now - 600_000, lastActivityAt: now })).status).toBe(204);
  const bytes = new TextEncoder().encode(body);
  expect((await client.archive(sessionId, "main", at, bytes)).status).toBe(200);
  return at + bytes.byteLength;
};

const archived = (h: Harness, client: Client, sessionId: string, entries: number): Promise<number> =>
  archivedBody(h, client, sessionId, transcriptOf(entries));

// Every window the walk visits, following one link until it runs out.
const walked = async (
  h: Harness,
  you: Owner,
  first: string,
  link: (html: string) => string | null,
): Promise<string[]> => {
  const windows: string[] = [];
  let html = await read(h, first, you.assertion);
  for (let step = 0; step < 40; step += 1) {
    windows.push(html);
    const next = link(html);
    if (next === null) return windows;
    html = await read(h, next, you.assertion);
  }
  throw new Error(`the walk from ${first} never reached an end`);
};

const eachEntryOnce = (windows: string[], entries: number): void => {
  for (let index = 0; index < entries; index += 1) {
    const prompt = `prompt ${String(index).padStart(3, "0")} `;
    const seen = windows.reduce((count, window) => count + occurrences(window, prompt), 0);
    expect({ prompt, seen }).toEqual({ prompt, seen: 1 });
  }
};

const form = async (h: Harness, path: string, assertion: string): Promise<{ csrf: string; cookie: string }> => {
  const response = await open(h, path, assertion);
  expect(response.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await response.text())?.[1];
  if (csrf === undefined) throw new Error("the session page shows no send form");
  return { csrf, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
};

interface Post {
  csrf: string;
  cookie: string;
  body: string;
}

const post = (h: Harness, path: string, assertion: string, fields: Post): Promise<Response> =>
  h.send(path, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": assertion,
      origin: ORIGIN,
      cookie: fields.cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf: fields.csrf, body: fields.body }),
  });

const send = async (h: Harness, path: string, assertion: string, body: string): Promise<Response> => {
  const { csrf, cookie } = await form(h, path, assertion);
  return post(h, path, assertion, { csrf, cookie, body });
};

const queued = (userId: string, toDeviceId: string, now: number): Promise<Message[]> =>
  runInDurableObject(env.MAILBOX.get(env.MAILBOX.idFromName(userId)), (mailbox: Mailbox) =>
    mailbox.list(toDeviceId, now),
  );

const deviceId = async (client: Client): Promise<string> => {
  const response = await client.request("GET", "/v1/devices");
  expect(response.status).toBe(200);
  const listed: { devices: { deviceId: string }[] } = await response.json();
  const device = listed.devices[0];
  if (!device) throw new Error("the account has no device");
  return device.deviceId;
};

describe("a session page", () => {
  it("reads one session's facts, its usage and the tail of its transcript", async () => {
    const h = await harness();
    const you = await owner(h);
    const now = h.now();
    expect(
      (
        await you.laptop.sync("9f8a1b2c", {
          host: "laptop",
          repo: "repo:github.com/mvhenten/recall",
          branch: "feat/dashboard-sessions",
          prompts: 2,
          focus: { first: "read the transcript", latest: "send it a message" },
          startedAt: now - 600_000,
          lastActivityAt: now,
        })
      ).status,
    ).toBe(204);
    expect((await you.laptop.usage("9f8a1b2c", { account: "work", at: now })).status).toBe(204);
    expect((await you.laptop.archive("9f8a1b2c", "main", 0, `${entry(1)}\n`)).status).toBe(200);

    const ledger = await read(h, "/dashboard", you.assertion);
    expect(ledger).toContain('<a href="/dashboard/sessions/9f8a1b2c">laptop-9f8a</a>');

    const html = await read(h, "/dashboard/sessions/9f8a1b2c", you.assertion);
    expect(html).toContain("laptop-9f8a");
    expect(html).toContain("repo:github.com/mvhenten/recall@feat/dashboard-sessions");
    expect(html).toContain('<span class="in">Account</span><span class="iv">work</span>');
    expect(html).toContain("prompt 001");
    expect(html).toContain("the end of the transcript");
  });

  it("says so when a session has no transcript archived, rather than reading as an empty one", async () => {
    const h = await harness();
    const you = await owner(h);
    expect((await you.laptop.sync("beefbeef")).status).toBe(204);

    const html = await read(h, "/dashboard/sessions/beefbeef", you.assertion);
    expect(html).toContain("No transcript is archived for this session.");
  });

  it("has no page for a session this account never held", async () => {
    const h = await harness();
    const you = await owner(h);
    const stranger = h.clientWithToken(await h.login(await h.invite(`other-${crypto.randomUUID()}@example.com`)));
    expect((await stranger.sync("aa11bb22")).status).toBe(204);

    expect((await open(h, "/dashboard/sessions/aa11bb22", you.assertion)).status).toBe(404);
    expect((await open(h, "/dashboard/sessions/two%20words", you.assertion)).status).toBe(404);
    expect((await open(h, "/dashboard/sessions/aa11bb22", null)).status).toBe(401);
  });
});

describe("the transcript window", () => {
  it("walks a long transcript in either direction and reads every entry exactly once", async () => {
    const h = await harness();
    const you = await owner(h);
    const entries = 200;
    const bytes = await archived(h, you.laptop, "cafe0001", entries);
    expect(bytes).toBeGreaterThan(TRANSCRIPT_WINDOW_BYTES * 2);
    const path = "/dashboard/sessions/cafe0001";

    const tail = await read(h, path, you.assertion);
    expect(tail).toContain(`prompt ${String(entries - 1).padStart(3, "0")} `);
    expect(tail).not.toContain("prompt 000 ");
    expect(tail).not.toContain('"origin"');
    expect(tail.length).toBeLessThan(TRANSCRIPT_WINDOW_BYTES * 2);
    expect(tail).toContain("the end of the transcript");

    const forwards = await walked(h, you, `${path}?at=0`, laterLink);
    expect(forwards[0]).toContain("the start of the transcript");
    expect(forwards.length).toBeGreaterThan(2);
    eachEntryOnce(forwards, entries);

    const backwards = await walked(h, you, path, earlierLink);
    expect(backwards[backwards.length - 1]).toContain("the start of the transcript");
    expect(backwards.length).toBeGreaterThan(2);
    eachEntryOnce(backwards, entries);
  });

  // The window is a byte budget, and an entry past it is still an entry: rendering the raw bytes
  // in the middle of one reads as a stretch that holds nothing, which is what a session that said
  // nothing looks like too.
  it("reads an entry longer than the window whole, rather than as a run of empty stretches", async () => {
    const h = await harness();
    const you = await owner(h);
    const huge = `prompt 001 ${"y".repeat(TRANSCRIPT_WINDOW_BYTES * 2)}`;
    const body = `${entry(0)}\n${JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      timestamp: new Date(1_700_000_001_000).toISOString(),
      message: { content: huge },
    })}\n${entry(2)}\n`;
    await archivedBody(h, you.laptop, "cafe0003", body);
    const path = "/dashboard/sessions/cafe0003";

    const windows = await walked(h, you, `${path}?at=0`, laterLink);

    expect(windows.some((window) => window.includes(huge))).toBe(true);
    eachEntryOnce(windows, 3);
    expect(windows.every((window) => !window.includes("This stretch holds no prose."))).toBe(true);
  });

  // A file whose first stretch landed past zero leaves a run of bytes no object covers. The read
  // steps over it, so where the read reached in the file and how much it read part company, and a
  // mark that confused the two re-read the entries either side of the hole.
  it("walks a file that starts past zero without reading an entry twice", async () => {
    const h = await harness();
    const you = await owner(h);
    const entries = 60;
    const bytes = await archivedBody(h, you.laptop, "cafe0004", transcriptOf(entries), 50_000);
    expect(bytes).toBeGreaterThan(TRANSCRIPT_WINDOW_BYTES);
    const path = "/dashboard/sessions/cafe0004";

    eachEntryOnce(await walked(h, you, `${path}?at=0`, laterLink), entries);
    eachEntryOnce(await walked(h, you, path, earlierLink), entries);
  });

  it("refuses a window the file cannot hold rather than reading an empty one", async () => {
    const h = await harness();
    const you = await owner(h);
    const bytes = await archived(h, you.laptop, "cafe0002", 4);
    const path = "/dashboard/sessions/cafe0002";

    expect((await open(h, `${path}?at=${bytes + 1}`, you.assertion)).status).toBe(400);
    expect((await open(h, `${path}?at=-1`, you.assertion)).status).toBe(400);
    expect((await open(h, `${path}?file=../main`, you.assertion)).status).toBe(400);
    expect(await read(h, `${path}?file=task-1`, you.assertion)).toContain("has no task-1 on record");
  });
});

describe("the send box", () => {
  it("queues a message to the session's own host, named for the browser that typed it", async () => {
    const h = await harness();
    const you = await owner(h);
    const laptopId = await deviceId(you.laptop);
    expect((await you.laptop.sync("9f8a1b2c")).status).toBe(204);
    const path = "/dashboard/sessions/9f8a1b2c";

    const sent = await send(h, path, you.assertion, "pull main and rerun the migration");
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe(path);

    const messages = await queued(you.userId, laptopId, h.now());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      toDeviceId: laptopId,
      toSessionId: "9f8a1b2c",
      fromDeviceId: "dashboard",
      fromHost: "dashboard",
      fromName: you.email,
      body: "pull main and rerun the migration",
    });

    // The notice belongs to the navigation the send redirected to and not to the address, so the
    // page it lands on says it once and the reload after it does not.
    const landed = await open(h, path, you.assertion, cookieFrom(sent));
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain("Queued for");
    expect(cookieFrom(landed)).not.toContain("9f8a1b2c");
    expect(await read(h, path, you.assertion)).not.toContain("Queued for");
  });

  // Two session pages open at once, or a Labels tab beside one, must not invalidate each other's
  // form: a page that minted a token per view would, since the browser holds one cookie.
  it("keeps the token a page arrived with, so a second page does not break the first", async () => {
    const h = await harness();
    const you = await owner(h);
    const laptopId = await deviceId(you.laptop);
    expect((await you.laptop.sync("9f8a1b2c")).status).toBe(204);
    expect((await you.laptop.sync("beefbeef")).status).toBe(204);
    const first = await form(h, "/dashboard/sessions/9f8a1b2c", you.assertion);

    const second = await open(h, "/dashboard/sessions/beefbeef", you.assertion, first.cookie);
    expect(second.status).toBe(200);
    const labels = await open(h, "/dashboard/labels", you.assertion, first.cookie);
    expect(labels.status).toBe(200);
    expect(/name="csrf" value="([^"]+)"/.exec(await labels.text())?.[1]).toBe(first.csrf);

    const sent = await post(h, "/dashboard/sessions/9f8a1b2c", you.assertion, { ...first, body: "still works" });
    expect(sent.status).toBe(303);
    expect(await queued(you.userId, laptopId, h.now())).toHaveLength(1);
  });

  it("says what went wrong and keeps the typing, rather than clearing the box on a refusal", async () => {
    const h = await harness();
    const you = await owner(h);
    const laptopId = await deviceId(you.laptop);
    expect((await you.laptop.sync("9f8a1b2c")).status).toBe(204);
    const path = "/dashboard/sessions/9f8a1b2c";

    const empty = await send(h, path, you.assertion, "   ");
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("The message was empty");

    const long = await send(h, path, you.assertion, "x".repeat(MAX_BODY_BYTES + 1));
    expect(long.status).toBe(400);
    const refused = await long.text();
    expect(refused).toContain(`A message holds at most ${MAX_BODY_BYTES} bytes`);
    expect(refused).toContain("x".repeat(MAX_BODY_BYTES));

    const { csrf, cookie } = await form(h, path, you.assertion);
    const stale = await post(h, path, you.assertion, { csrf: "wrong", cookie, body: "a stale token" });
    expect(stale.status).toBe(403);
    // The refusal is the form again, carrying the typing and a token the retry can use, and not
    // a notice page that throws the draft away.
    const again = await stale.text();
    expect(again).toContain("a stale token");
    expect(again).toContain("did not come from this page");
    expect((await post(h, path, you.assertion, { csrf, cookie: "", body: "no cookie" })).status).toBe(403);
    expect(
      (
        await h.send(path, {
          method: "POST",
          headers: { "cf-access-jwt-assertion": you.assertion, origin: "https://elsewhere.test", cookie },
          body: new URLSearchParams({ csrf, body: "wrong origin" }),
        })
      ).status,
    ).toBe(403);

    expect(await queued(you.userId, laptopId, h.now())).toEqual([]);
  });

  // The bus reaches a session for as long as its host holds it, which is a day after its last
  // prompt. Idle is not gone: the box is offered on the same rule the delivery runs on, and the
  // page and the refusal answer for that one rule rather than two.
  it("offers the box while the host holds the session, and refuses once it has let it go", async () => {
    const h = await harness();
    const you = await owner(h);
    const laptopId = await deviceId(you.laptop);
    expect((await you.laptop.sync("deadbeef")).status).toBe(204);
    const path = "/dashboard/sessions/deadbeef";
    const { csrf, cookie } = await form(h, path, you.assertion);

    h.tick(7 * 3_600_000);
    const idle = await read(h, path, you.assertion);
    expect(idle).toContain("idle ");
    expect(idle).toContain("</textarea>");
    const reached = await post(h, path, you.assertion, { csrf, cookie, body: "still there?" });
    expect(reached.status).toBe(303);

    h.tick(25 * 3_600_000);
    const over = await read(h, path, you.assertion);
    expect(over).toContain("No host is running this session any more");
    expect(over).not.toContain("</textarea>");

    const refused = await post(h, path, you.assertion, { csrf, cookie, body: "anyone there" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("No host is running this session any more, so the bus has nowhere");
    expect(await queued(you.userId, laptopId, h.now())).toHaveLength(1);
  });
});
