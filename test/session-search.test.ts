import { describe, expect, it } from "vitest";
import { CHUNK_RECENT } from "../src/app";
import type { PastSession, SessionHit } from "../src/model";
import { harness } from "./harness";

const line = (entry: Record<string, unknown>): string => `${JSON.stringify(entry)}\n`;

const prompt = (text: string): string => line({ type: "user", origin: { kind: "human" }, message: { content: text } });

const answer = (text: string): string =>
  line({ type: "assistant", message: { model: "claude-opus-5", content: [{ type: "text", text }] } });

const named = (name: string): string => line({ type: "agent-name", agentName: name });

const about = (subject: string): string =>
  [
    prompt(`${subject}: ${`what ${subject} does, and why it does it that way. `.repeat(20)}`),
    answer(`${subject} works like this: ${`${subject} does its job. `.repeat(20)}`),
  ].join("");

// The lines of a transcript as the records an append carries, which is how prose reaches the index.
const recordsOf = (text: string): string[] => text.split("\n").filter((line) => line !== "");

// A word made of letters alone, since the test embedder is blind to any token holding a digit.
const coined = (at: number): string => {
  let rest = at;
  let word = "";
  for (let letter = 0; letter < 4; letter += 1) {
    word += String.fromCharCode(97 + (rest % 26));
    rest = Math.floor(rest / 26);
  }
  return word;
};

// Turns that share no word with each other, so each closes a chunk of its own, and none with any
// query, so none of them can win one. This is the archive a search has to stay cheap over.
const filler = (turns: number): string => {
  const written: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const words: string[] = [];
    for (let word = 0; word < 90; word += 1) words.push(coined(turn * 90 + word));
    written.push(prompt(words.join(" ")));
  }
  return written.join("");
};

const sessionOf = async (response: Response): Promise<PastSession> => {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { session: PastSession };
  return body.session;
};

const hitsOf = async (response: Response): Promise<SessionHit[]> => {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { hits: SessionHit[] };
  return body.hits;
};

describe("finding a stored session", () => {
  it("answers to the name Claude Code gave it, to its handle and to its session id", async () => {
    const h = await harness();
    const client = await h.user("finder");
    const id = "11112222-3333-4444-5555-666677778888";
    await client.sync(id);
    await client.v2.records(id, "main", 0, recordsOf(named("kisuvpalas") + about("the signing key")));

    const session = await sessionOf(await client.session("kisuvpalas"));

    expect(session.sessionId).toBe(id);
    expect(session.agentName).toBe("kisuvpalas");
    expect(session.cwd).toBe("/home/you/src/recall");
    expect((await sessionOf(await client.session(id))).agentName).toBe("kisuvpalas");
    expect((await sessionOf(await client.session(session.name))).sessionId).toBe(id);
    expect((await client.session("nobody-here")).status).toBe(404);
  });

  // The harness hands the same word to a session resumed weeks later, so a name is not a key. The
  // most recent is the one a caller typing a name from memory means, and `--restore` writes a
  // transcript to disk off that pick, so the count rides along rather than the choice being made
  // silently.
  it("takes the most recent of the sessions a name answers for, and says how many there were", async () => {
    const h = await harness();
    const client = await h.user("twin");
    await client.sync("s-older", { lastActivityAt: new Date(h.now() + 1_000).toISOString() });
    await client.v2.records("s-older", "main", 0, recordsOf(named("lobivdigob") + about("the first run")));
    await client.sync("s-newer", { lastActivityAt: new Date(h.now() + 90_000).toISOString() });
    await client.v2.records("s-newer", "main", 0, recordsOf(named("lobivdigob") + about("the second run")));

    const found = (await (await client.session("lobivdigob")).json()) as { session: PastSession; matches: number };

    expect(found.session.sessionId).toBe("s-newer");
    expect(found.matches).toBe(2);
    const single = (await (await client.session("s-older")).json()) as { matches: number };
    expect(single.matches).toBe(1);
  });

  it("answers no caller the session does not belong to", async () => {
    const h = await harness();
    const owner = await h.user("keeper");
    const stranger = await h.user("passerby");
    await owner.sync("s-private");
    await owner.v2.records("s-private", "main", 0, recordsOf(named("vatoglojaf") + about("nothing to see")));

    expect((await stranger.session("vatoglojaf")).status).toBe(404);
    expect((await stranger.session("s-private")).status).toBe(404);
  });
});

describe("searching sessions by meaning", () => {
  it("finds the session that talked about a subject, on whichever host it ran", async () => {
    const h = await harness();
    const client = await h.user("searcher");
    await client.sync("s-archive", { host: "tower" });
    await client.v2.records(
      "s-archive",
      "main",
      0,
      recordsOf(named("pihokkokuk") + about("the transcript archive offset")),
    );
    await client.sync("s-pipeline", { host: "laptop" });
    await client.v2.records("s-pipeline", "main", 0, recordsOf(named("latimmakom") + about("the release pipeline")));
    await client.v2.end("s-archive");
    await client.v2.end("s-pipeline");

    const found = await hitsOf(await client.searchSessions("where does the transcript archive keep its offset"));

    expect(found[0]?.session.sessionId).toBe("s-archive");
    expect(found[0]?.session.agentName).toBe("pihokkokuk");
    expect(found[0]?.session.host).toBe("tower");
    expect(found[0]?.excerpt.text).toContain("transcript archive offset");
  });

  it("holds one account's sessions apart from another's", async () => {
    const h = await harness();
    const mine = await h.user("mine");
    const theirs = await h.user("theirs");
    await mine.sync("s-mine");
    await mine.v2.records("s-mine", "main", 0, recordsOf(named("gapulbadag") + about("the signing key rotation")));
    await theirs.sync("s-theirs");
    await theirs.v2.records("s-theirs", "main", 0, recordsOf(named("minuksijaj") + about("the signing key rotation")));
    await mine.v2.end("s-mine");
    await theirs.v2.end("s-theirs");

    const found = await hitsOf(await mine.searchSessions("signing key rotation"));

    expect(found.map((hit) => hit.session.sessionId)).toEqual(["s-mine"]);
  });

  // A search reads the full-text candidates and the newest chunks, not the whole archive. The
  // three sessions here were indexed before a filler session longer than that window, so every
  // chunk that can win one of these queries sits outside it and is reachable only through the
  // full-text pass. The same queries answered with the same chunks when the scan was unbounded.
  it("ranks the same chunks top once the archive has outgrown the window the scan covers", async () => {
    const h = await harness();
    const userId = `bounded-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    const subjects = [
      ["s-offset", "the transcript archive offset", "where does the transcript archive keep its offset"],
      ["s-pipeline", "the release pipeline", "what runs in the release pipeline"],
      ["s-labels", "the labels tab", "the labels tab"],
    ] as const;
    for (const [sessionId, subject] of subjects) {
      await client.sync(sessionId);
      await client.v2.records(sessionId, "main", 0, recordsOf(about(subject)));
      await client.v2.end(sessionId);
    }
    await client.sync("s-filler");
    const written = recordsOf(filler(CHUNK_RECENT + 100));
    for (let at = 0; at < written.length; at += 500) {
      await client.v2.records("s-filler", "main", at, written.slice(at, at + 500));
    }
    await client.v2.end("s-filler");
    expect((await h.chunks(userId, "s-filler")).length).toBeGreaterThan(CHUNK_RECENT);

    for (const [sessionId, subject, query] of subjects) {
      const found = await hitsOf(await client.searchSessions(query));
      expect([query, found[0]?.session.sessionId]).toEqual([query, sessionId]);
      expect(found[0]?.excerpt.text).toContain(subject);
    }
  });
});

describe("restoring a stored session", () => {
  it("reads a transcript file back whole, however many appends it arrived in", async () => {
    const h = await harness();
    const client = await h.user("restorer");
    await client.sync("s-restore");
    const whole = named("nufogruzup") + about("the restore path");
    const written = recordsOf(whole);
    const head = written.slice(0, Math.floor(written.length / 2));
    expect((await client.v2.records("s-restore", "main", 0, head)).status).toBe(200);
    expect((await client.v2.records("s-restore", "main", head.length, written.slice(head.length))).status).toBe(200);
    expect((await client.v2.records("s-restore", "agent-7f21", 0, recordsOf(answer("a delegated turn")))).status).toBe(
      200,
    );

    const read = await client.readTranscript("s-restore", "main");

    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await read.text()).toBe(whole);
    const stored = (await (await client.session("s-restore")).json()) as { files: Array<{ file: string }> };
    expect(stored.files.map((file) => file.file)).toEqual(["agent-7f21", "main"]);
    expect((await client.readTranscript("s-restore", "agent-9999")).status).toBe(404);
  });
});
