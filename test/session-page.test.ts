import { describe, expect, it } from "vitest";
import { TRANSCRIPT_FOLLOW_MS, TRANSCRIPT_STEP_BYTES } from "../src/dashboard";
import { MAX_BODY_BYTES, type Message, type NewsFrame, ORDERS, ORDERS_HEADER } from "../src/mailbox";
import { SESSION_TTL_MS } from "../src/model";
import { followedRecords, type Plan, type RecordReach } from "../src/transcript-plan";
import { type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

const ORIGIN = "https://recall.test";

interface Owner {
  userId: string;
  email: string;
  assertion: string;
  token: string;
  laptop: Client;
}

const owner = async (h: Harness): Promise<Owner> => {
  const userId = `user-${crypto.randomUUID()}`;
  const email = await h.invite(`${userId}@example.com`, userId);
  const token = await h.login(email);
  return { userId, email, assertion: await h.assertionFor(email), token, laptop: h.clientWithToken(token) };
};

// A send from the dashboard reaches a session the same way one from another host does: through a
// socket the host has open. News answers nothing back, so this only has to be attached.
const attach = async (h: Harness, token: string): Promise<WebSocket> => {
  const response = await h.send("/v2/messages/listen", {
    headers: { authorization: `Bearer ${token}`, upgrade: "websocket", [ORDERS_HEADER]: ORDERS },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("the listen upgrade carried no socket");
  socket.accept();
  return socket;
};

const framesOn = (socket: WebSocket): Message[] => {
  const received: Message[] = [];
  socket.addEventListener("message", (event) => {
    received.push((JSON.parse(String(event.data)) as NewsFrame).message);
  });
  return received;
};

const eventually = async (ready: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} never happened`);
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

const manifestOf = (html: string): Plan => {
  const found = /<script type="application\/json" id="txplan">([^<]*)<\/script>/.exec(html)?.[1];
  if (found === undefined) throw new Error("the session page carries no transcript manifest");
  return JSON.parse(found);
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

// One peek asked of a session, the way a host asks for one. Nothing is listening in these tests,
// so the row is written and stays pending until a digest is put on it.
const askPeek = async (client: Client, sessionId: string): Promise<string> => {
  const response = await client.request("POST", `/v2/sessions/${sessionId}/peek`);
  expect(response.status).toBe(201);
  const asked: { peek: { peekId: string } } = await response.json();
  return asked.peek.peekId;
};

const deviceId = async (client: Client): Promise<string> => {
  const response = await client.request("GET", "/v2/devices");
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
    expect((await you.laptop.v2.records("9f8a1b2c", "main", 0, [entry(1)])).status).toBe(200);

    const ledger = await read(h, "/dashboard", you.assertion);
    expect(ledger).toContain('<a href="/dashboard/sessions/9f8a1b2c">laptop-9f8a</a>');

    const response = await open(h, "/dashboard/sessions/9f8a1b2c", you.assertion);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("laptop-9f8a");
    expect(html).toContain("repo:github.com/mvhenten/recall@feat/dashboard-sessions");
    expect(html).toContain('<span class="in">Account</span><span class="iv">work</span>');

    const plan = manifestOf(html);
    expect(plan).toMatchObject({ file: "main", bytes: `${entry(1)}\n`.length });
    expect(await rejoined(h, plan, you.assertion)).toBe(`${entry(1)}\n`);

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

  // A peek is asked for from a host and answered on that host, so the page is where the answers
  // pile up. The one a summariser has not written yet reads as pending, since an asker opening the
  // page seconds later is reading the row it is waiting on.
  it("lists the peeks asked of a session, newest first, and says which is still pending", async () => {
    const h = await harness();
    const you = await owner(h);
    expect((await you.laptop.sync("cafe0001")).status).toBe(204);
    const answered = await askPeek(you.laptop, "cafe0001");
    const written = await you.laptop.request("PUT", `/v2/sessions/cafe0001/peek/${answered}`, {
      digest: "running the tenant migration",
    });
    expect(written.status).toBe(204);
    h.advance(60_000);
    await askPeek(you.laptop, "cafe0001");

    const html = await read(h, "/dashboard/sessions/cafe0001", you.assertion);

    const pending = html.indexOf('<span class="in">Pending</span><span class="iv">0s ago</span>');
    const ready = html.indexOf('<span class="in">running the tenant migration</span><span class="iv">1m ago</span>');
    expect(pending).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(pending);
    expect(html).toContain("2 peeks · last 20 kept");
  });

  it("draws no peek card for a session nobody has asked about", async () => {
    const h = await harness();
    const you = await owner(h);
    expect((await you.laptop.sync("cafe0002")).status).toBe(204);

    const html = await read(h, "/dashboard/sessions/cafe0002", you.assertion);

    expect(html).not.toContain("Peeks");
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

// One append of records, the way a host on `/v2` writes its transcript.
const recordedBody = async (
  h: Harness,
  client: Client,
  sessionId: string,
  records: string[],
  from = 0,
): Promise<number> => {
  const now = h.now();
  expect((await client.sync(sessionId, { startedAt: now - 600_000, lastActivityAt: now })).status).toBe(204);
  expect((await client.v2.records(sessionId, "main", from, records)).status).toBe(200);
  return from + records.length;
};

// One window of records, fetched the way the browser fetches it: two ordinals off the manifest and
// no range at all.
const windowOf = (h: Harness, plan: Plan, from: number, through: number, assertion: string): Promise<Response> =>
  h.send(`${plan.path}?file=${encodeURIComponent(plan.file)}&records=${from}.${through}`, {
    headers: { "cf-access-jwt-assertion": assertion },
  });

// The whole of a file, read back out of the manifest alone. Whatever this reads is what a browser
// reading against the same manifest sees. A window carries the break that closed its last record,
// so the windows of a file lay end to end exactly as its objects do.
const rejoined = async (h: Harness, plan: Plan, assertion: string): Promise<string> => {
  const parts: string[] = [];
  for (const span of plan.spans) {
    const response = await windowOf(h, plan, span.from, span.from + span.held, assertion);
    expect(response.status).toBe(200);
    parts.push(await response.text());
  }
  return parts.join("");
};

// What a file written as records reads back as: its lines, each closed by a break.
const recordedText = (records: string[]): string => `${records.join("\n")}\n`;

const recordBeatOf = (h: Harness, plan: Plan, since: number, assertion: string): Promise<Response> =>
  h.send(`${plan.path}?file=${encodeURIComponent(plan.file)}&since=${since}`, {
    headers: { "cf-access-jwt-assertion": assertion },
  });

describe("a session page over a transcript", () => {
  it("reads a session the record path wrote, off the manifest the page carries", async () => {
    const h = await harness();
    const you = await owner(h);
    const written = [entry(0), entry(1), entry(2)];
    await recordedBody(h, you.laptop, "cafe0100", written);

    const html = await read(h, "/dashboard/sessions/cafe0100", you.assertion);
    expect(html).not.toContain("No transcript is archived for this session.");
    const plan = manifestOf(html);
    expect(plan.file).toBe("main");
    expect(await rejoined(h, plan, you.assertion)).toBe(recordedText(written));
  });

  it("says which files a session archived, and says so when it never archived the one asked for", async () => {
    const h = await harness();
    const you = await owner(h);
    await recordedBody(h, you.laptop, "cafe0002", [entry(0), entry(1)]);
    expect((await you.laptop.v2.records("cafe0002", "task-7", 0, [entry(2)])).status).toBe(200);
    const path = "/dashboard/sessions/cafe0002";

    const html = await read(h, path, you.assertion);
    expect(html).toContain(`<a href="${path}?file=task-7">task-7</a>`);
    expect(manifestOf(html).file).toBe("main");
    expect(manifestOf(await read(h, `${path}?file=task-7`, you.assertion)).file).toBe("task-7");
    expect(await read(h, `${path}?file=task-1`, you.assertion)).toContain("has no task-1 on record");
    expect((await open(h, `${path}?file=../main`, you.assertion)).status).toBe(400);
  });

  // One key under a session's record prefix that this archive did not write must not take the
  // page down with it: labels, the send box and every insight card hang off the same render.
  it("draws a session whose record prefix holds a key the archive did not write", async () => {
    const h = await harness();
    const you = await owner(h);
    const written = [entry(0), entry(1)];
    await recordedBody(h, you.laptop, "cafe0106", written);
    await h.strayRecord(you.userId, "cafe0106", "main/not-an-ordinal");

    const html = await read(h, "/dashboard/sessions/cafe0106", you.assertion);
    expect(await rejoined(h, manifestOf(html), you.assertion)).toBe(recordedText(written));
  });

  // A run of records the archive never got leaves the file in two pieces. The walk reads both and
  // the page says how many records fell in the gap, rather than drawing the far side as the whole
  // file and removing the control that would have reached the rest.
  it("reads both sides of a hole in the records, and says how many fell in it", async () => {
    const h = await harness();
    const you = await owner(h);
    const head = [entry(0), entry(1)];
    const tail = [entry(5), entry(6)];
    await recordedBody(h, you.laptop, "cafe0107", head);
    expect(await h.storeRecords(you.userId, "cafe0107", "main", 5, tail)).toBe(true);

    const html = await read(h, "/dashboard/sessions/cafe0107", you.assertion);
    expect(html).toContain("The archive never got 3 records of this file, in 1 place.");
    const plan = manifestOf(html);

    // Both sides of the hole are reachable, and a window spanning it is a read the archive cannot
    // answer: it says so rather than handing back the records either side as though they joined up.
    expect(await (await windowOf(h, plan, 5, 7, you.assertion)).text()).toBe(recordedText(tail));
    expect(await (await windowOf(h, plan, 0, 2, you.assertion)).text()).toBe(recordedText(head));
    expect((await windowOf(h, plan, 0, 7, you.assertion)).status).toBe(404);
  });

  // A file the archive caught late opens past ordinal zero with nothing listed behind it. The page
  // must say the archive never got those records, not that it held them back at its own ceiling:
  // one is a gap nobody can close and the other is a control the reader could have clicked.
  it("calls a hole at the start of a file a hole, and not a manifest held back", async () => {
    const h = await harness();
    const you = await owner(h);
    const written = [entry(3), entry(4)];
    expect((await you.laptop.sync("cafe0108")).status).toBe(204);
    expect(await h.storeRecords(you.userId, "cafe0108", "main", 3, written)).toBe(true);

    const html = await read(h, "/dashboard/sessions/cafe0108", you.assertion);
    expect(html).toContain("The archive never got 3 records of this file, in 1 place.");
    expect(html).not.toContain("so the box stops short of the start of the session");
    expect(await rejoined(h, manifestOf(html), you.assertion)).toBe(recordedText(written));
  });

  // A record is addressed by its ordinal, so the box follows the file by counting records and
  // never by counting bytes: the beat says which objects hold records it has not read, and the
  // window it asks for next opens exactly where the page's manifest stopped.
  it("follows a session writing records, reading forward by ordinal", async () => {
    const h = await harness();
    const you = await owner(h);
    const at = await recordedBody(h, you.laptop, "cafe0102", [entry(0), entry(1)]);
    const plan = manifestOf(await read(h, "/dashboard/sessions/cafe0102", you.assertion));
    expect(plan.follow).toEqual({ from: at, every: TRANSCRIPT_FOLLOW_MS });

    const quiet: RecordReach = await (await recordBeatOf(h, plan, at, you.assertion)).json();
    expect(quiet).toEqual({ running: true, spans: [] });

    const grew = [entry(2), entry(3)];
    await recordedBody(h, you.laptop, "cafe0102", grew, at);
    const beat: RecordReach = await (await recordBeatOf(h, plan, at, you.assertion)).json();
    expect(beat.running).toBe(true);
    const window = followedRecords(beat.spans, at, TRANSCRIPT_STEP_BYTES);
    expect(window).toMatchObject({ from: at, through: at + grew.length });
    const landed = await windowOf(h, plan, window.from, window.through, you.assertion);
    expect(landed.status).toBe(200);
    expect(await landed.text()).toBe(recordedText(grew));
  });

  it("says a session nobody is running is no longer worth following", async () => {
    const h = await harness();
    const you = await owner(h);
    const at = await recordedBody(h, you.laptop, "cafe0103", [entry(0), entry(1)]);
    const plan = manifestOf(await read(h, "/dashboard/sessions/cafe0103", you.assertion));
    h.tick(SESSION_TTL_MS + 1);

    const cold: RecordReach = await (await recordBeatOf(h, plan, at, you.assertion)).json();
    expect(cold.running).toBe(false);
    expect(manifestOf(await read(h, "/dashboard/sessions/cafe0103", you.assertion)).follow).toBeNull();
  });

  it("refuses a window no ordinal pair names, and a reader the session does not belong to", async () => {
    const h = await harness();
    const you = await owner(h);
    await recordedBody(h, you.laptop, "cafe0104", [entry(0), entry(1)]);
    const plan = manifestOf(await read(h, "/dashboard/sessions/cafe0104", you.assertion));

    expect(
      (await h.send(`${plan.path}?file=main&records=2.1`, { headers: { "cf-access-jwt-assertion": you.assertion } }))
        .status,
    ).toBe(400);
    expect((await recordBeatOf(h, plan, -1, you.assertion)).status).toBe(400);
    expect((await windowOf(h, plan, 0, 2, await h.assertionFor("stranger@example.com"))).status).toBe(403);
  });
});

describe("the send box", () => {
  it("pushes a message to the session's own host, named for the browser that typed it", async () => {
    const h = await harness();
    const you = await owner(h);
    const laptopId = await deviceId(you.laptop);
    expect((await you.laptop.sync("9f8a1b2c")).status).toBe(204);
    const path = "/dashboard/sessions/9f8a1b2c";
    const received = framesOn(await attach(h, you.token));

    const sent = await send(h, path, you.assertion, "pull main and rerun the migration");
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe(path);

    await eventually(() => received.length === 1, "the push to the host");
    expect(received[0]).toMatchObject({
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
    expect(await landed.text()).toContain("Sent to");
    expect(cookieFrom(landed)).not.toContain("9f8a1b2c");
    expect(await read(h, path, you.assertion)).not.toContain("Sent to");
  });

  // Two session pages open at once, or a Labels tab beside one, must not invalidate each other's
  // form: a page that minted a token per view would, since the browser holds one cookie.
  it("keeps the token a page arrived with, so a second page does not break the first", async () => {
    const h = await harness();
    const you = await owner(h);
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
  });

  it("says what went wrong and keeps the typing, rather than clearing the box on a refusal", async () => {
    const h = await harness();
    const you = await owner(h);
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
  });

  // The bus reaches a session for as long as its host holds it, which is a day after its last
  // prompt. Idle is not gone: the box is offered on the same rule the delivery runs on, and the
  // page and the refusal answer for that one rule rather than two.
  it("offers the box while the host holds the session, and refuses once it has let it go", async () => {
    const h = await harness();
    const you = await owner(h);
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
  });
});
