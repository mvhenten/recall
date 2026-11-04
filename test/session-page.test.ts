import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_STEP_BYTES } from "../src/dashboard";
import { MAX_BODY_BYTES, type Mailbox, type Message } from "../src/mailbox";
import type { Read, Run } from "../src/transcript-plan";
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

const entry = (index: number, pad = 1_200 + ((index * 137) % 1_600)): string =>
  JSON.stringify({
    type: "user",
    origin: { kind: "human" },
    timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    message: { content: `prompt ${String(index).padStart(3, "0")} ${"x".repeat(pad)}` },
  });

const transcriptOf = (entries: number): string =>
  `${Array.from({ length: entries }, (_, index) => entry(index)).join("\n")}\n`;

interface Plan {
  path: string;
  file: string;
  bytes: number;
  step: number;
  runs: Run[];
}

const planOf = (html: string): Plan => {
  const found = /<script type="application\/json" id="txplan">([^<]*)<\/script>/.exec(html)?.[1];
  if (found === undefined) throw new Error("the session page carries no transcript manifest");
  return JSON.parse(found);
};

const archivedBody = async (h: Harness, client: Client, sessionId: string, body: string, at = 0): Promise<number> => {
  const now = h.now();
  expect((await client.sync(sessionId, { startedAt: now - 600_000, lastActivityAt: now })).status).toBe(204);
  const bytes = new TextEncoder().encode(body);
  expect((await client.archive(sessionId, "main", at, bytes)).status).toBe(200);
  return at + bytes.byteLength;
};

// One stretch, fetched the way the browser fetches it: the manifest names the object and the span
// of it to take, and the range header is what asks for that span.
const bytesOf = (h: Harness, plan: Plan, read: Read, assertion: string, span?: string): Promise<Response> =>
  h.send(`${plan.path}?file=${encodeURIComponent(plan.file)}&at=${read.offset}`, {
    headers: {
      "cf-access-jwt-assertion": assertion,
      range: span ?? `bytes=${read.skip}-${read.skip + read.bytes - 1}`,
    },
  });

// The whole of a file, reassembled out of the manifest alone, with a marker where the manifest
// says a hole sits. Whatever this reads is what a browser reading against the same manifest sees.
const reassembled = async (h: Harness, plan: Plan, assertion: string): Promise<string> => {
  const parts: string[] = [];
  for (const run of plan.runs) {
    if (parts.length > 0) parts.push("|hole|");
    for (const read of run.reads) {
      const response = await bytesOf(h, plan, read, assertion);
      expect(response.status).toBe(206);
      parts.push(await response.text());
    }
  }
  return parts.join("");
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

    const response = await open(h, "/dashboard/sessions/9f8a1b2c", you.assertion);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("laptop-9f8a");
    expect(html).toContain("repo:github.com/mvhenten/recall@feat/dashboard-sessions");
    expect(html).toContain('<span class="in">Account</span><span class="iv">work</span>');

    const plan = planOf(html);
    expect(plan).toMatchObject({ file: "main", bytes: `${entry(1)}\n`.length });
    expect(await reassembled(h, plan, you.assertion)).toBe(`${entry(1)}\n`);

    // The box is filled by a script this Worker serves, off bytes it fetches back from this Worker,
    // so a policy that refuses either leaves a dead box.
    expect(html).toContain(`<script src="/transcript.js" defer></script>`);
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'self'");

    const script = await open(h, "/transcript.js", you.assertion);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toContain("txplan");
  });

  // The script sits outside /dashboard so that it is outside the Access application gating it: a
  // tab restored from bfcache after the sign-in ran out would be redirected to a login page for
  // the script, and the policy the page runs under forbids the inline handler that would notice.
  it("serves the transcript script to a reader with no dashboard sign-in", async () => {
    const h = await harness();
    const script = await open(h, "/transcript.js", null);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("txplan");
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

describe("the transcript manifest", () => {
  // Every byte of the file is named by exactly one read, so a browser that fetches the manifest
  // in order holds the file and nothing doubled.
  it("names every stretch of a long transcript, covering the file once and exactly", async () => {
    const h = await harness();
    const you = await owner(h);
    const body = transcriptOf(200);
    const stretch = 40_000;
    for (let at = 0; at < body.length; at += stretch) {
      await archivedBody(h, you.laptop, "cafe0001", body.slice(at, at + stretch), at);
    }
    expect(body.length).toBeGreaterThan(TRANSCRIPT_STEP_BYTES * 2);

    const plan = planOf(await read(h, "/dashboard/sessions/cafe0001", you.assertion));
    expect(plan.bytes).toBe(body.length);
    expect(plan.runs).toHaveLength(1);
    expect(plan.runs[0]).toMatchObject({ from: 0, to: body.length });
    expect(plan.runs[0]?.reads.every((read) => read.skip === 0)).toBe(true);
    expect(await reassembled(h, plan, you.assertion)).toBe(body);
  });

  // A file whose first stretch landed past zero leaves a run of bytes that sit in no object. The
  // manifest says where the hole is rather than pretending the bytes either side of it join up,
  // which is what had an earlier reader print the entries around it twice.
  it("breaks a file with a hole in it into runs, so nothing is read across the hole", async () => {
    const h = await harness();
    const you = await owner(h);
    const head = transcriptOf(4);
    const tail = transcriptOf(6);
    await archivedBody(h, you.laptop, "cafe0004", head, 0);
    await archivedBody(h, you.laptop, "cafe0004", tail, 50_000);

    const html = await read(h, "/dashboard/sessions/cafe0004", you.assertion);
    expect(html).toContain(`The archive never got ${50_000 - head.length} bytes of this file, in 1 place.`);
    const plan = planOf(html);
    // What the page counts down is what can be read, so the progress line reaches the end of a
    // holed file rather than stopping short of it by the size of the hole for ever.
    expect(plan.bytes).toBe(head.length + tail.length);
    expect(plan.runs.map((run) => ({ from: run.from, to: run.to }))).toEqual([
      { from: 0, to: head.length },
      { from: 50_000, to: 50_000 + tail.length },
    ]);
    expect(await reassembled(h, plan, you.assertion)).toBe(`${head}|hole|${tail}`);
  });

  // A file the archive only ever caught the end of has a hole in front of everything it holds,
  // and nothing in the manifest says where the file starts, so counting from its first run would
  // report a whole file with no gap in it.
  it("counts the bytes in front of the first stretch as the hole they are", async () => {
    const h = await harness();
    const you = await owner(h);
    const tail = transcriptOf(3);
    await archivedBody(h, you.laptop, "cafe0005", tail, 9_000);

    const html = await read(h, "/dashboard/sessions/cafe0005", you.assertion);
    expect(html).toContain("The archive never got 9000 bytes of this file, in 1 place.");
    expect(planOf(html).bytes).toBe(tail.length);
  });

  it("says which files a session archived, and says so when it never archived the one asked for", async () => {
    const h = await harness();
    const you = await owner(h);
    await archivedBody(h, you.laptop, "cafe0002", transcriptOf(2));
    expect((await you.laptop.archive("cafe0002", "task-7", 0, transcriptOf(1))).status).toBe(200);
    const path = "/dashboard/sessions/cafe0002";

    expect(planOf(await read(h, path, you.assertion)).file).toBe("main");
    expect(planOf(await read(h, `${path}?file=task-7`, you.assertion)).file).toBe("task-7");
    expect(await read(h, `${path}?file=task-1`, you.assertion)).toContain("has no task-1 on record");
    expect((await open(h, `${path}?file=../main`, you.assertion)).status).toBe(400);
  });
});

describe("the transcript bytes", () => {
  it("answers the range the browser asked for and nothing around it", async () => {
    const h = await harness();
    const you = await owner(h);
    const body = transcriptOf(3);
    await archivedBody(h, you.laptop, "beef0001", body);
    const plan = planOf(await read(h, "/dashboard/sessions/beef0001", you.assertion));
    const read0 = plan.runs[0]?.reads[0];
    if (read0 === undefined) throw new Error("the manifest names no stretch");

    const response = await bytesOf(h, plan, read0, you.assertion, "bytes=10-29");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 10-29/${body.length}`);
    expect(await response.text()).toBe(body.slice(10, 30));
  });

  // A dead scrollbox is the one answer the reader cannot tell from a session that said nothing,
  // so every way of asking for bytes that cannot be had says which way it was.
  it("refuses a range, a stretch and a caller it cannot answer, rather than answering empty", async () => {
    const h = await harness();
    const you = await owner(h);
    const body = transcriptOf(3);
    await archivedBody(h, you.laptop, "beef0002", body);
    const plan = planOf(await read(h, "/dashboard/sessions/beef0002", you.assertion));
    const here = plan.runs[0]?.reads[0];
    if (here === undefined) throw new Error("the manifest names no stretch");
    const gone: Read = { offset: 90_000, skip: 0, bytes: 10 };

    expect((await bytesOf(h, plan, here, you.assertion, "bytes=0-")).status).toBe(416);
    expect((await bytesOf(h, plan, here, you.assertion, `bytes=0-${body.length}`)).status).toBe(416);
    expect((await bytesOf(h, plan, gone, you.assertion)).status).toBe(404);
    expect((await bytesOf(h, plan, here, await h.assertionFor("stranger@example.com"))).status).toBe(403);
    expect((await h.send(`${plan.path}?file=main&at=0`, { headers: { range: "bytes=0-9" } })).status).toBe(401);

    // The key is built from the user the assertion resolved to and the file is a single segment,
    // so a name that tries to climb out of the prefix is refused rather than joined into a key.
    const climb = await bytesOf(h, { ...plan, file: "../main" }, here, you.assertion);
    expect(climb.status).toBe(400);
    expect((await bytesOf(h, { ...plan, file: ".hidden" }, here, you.assertion)).status).toBe(400);
    // A malformed address is a malformed address, whichever part of it is malformed.
    const named = `/dashboard/sessions/two%20words/transcript?file=main&at=0`;
    expect(
      (await h.send(named, { headers: { "cf-access-jwt-assertion": you.assertion, range: "bytes=0-9" } })).status,
    ).toBe(400);
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
