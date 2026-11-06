import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PastSession, SessionHit } from "../src/model";
import { harness, UNEMBEDDABLE } from "./harness";

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

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

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
    await client.archive(id, "main", 0, named("kisuvpalas") + about("the signing key"));
    await h.deliver();

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
    await client.sync("s-older", { lastActivityAt: h.now() + 1_000 });
    await client.archive("s-older", "main", 0, named("lobivdigob") + about("the first run"));
    await client.sync("s-newer", { lastActivityAt: h.now() + 90_000 });
    await client.archive("s-newer", "main", 0, named("lobivdigob") + about("the second run"));
    await h.deliver();

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
    await owner.archive("s-private", "main", 0, named("vatoglojaf") + about("nothing to see"));
    await h.deliver();

    expect((await stranger.session("vatoglojaf")).status).toBe(404);
    expect((await stranger.session("s-private")).status).toBe(404);
  });
});

describe("searching sessions by meaning", () => {
  it("finds the session that talked about a subject, on whichever host it ran", async () => {
    const h = await harness();
    const client = await h.user("searcher");
    await client.sync("s-archive", { host: "tower" });
    await client.archive("s-archive", "main", 0, named("pihokkokuk") + about("the transcript archive offset"));
    await client.sync("s-pipeline", { host: "laptop" });
    await client.archive("s-pipeline", "main", 0, named("latimmakom") + about("the release pipeline"));
    await h.deliver();

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
    await mine.archive("s-mine", "main", 0, named("gapulbadag") + about("the signing key rotation"));
    await theirs.sync("s-theirs");
    await theirs.archive("s-theirs", "main", 0, named("minuksijaj") + about("the signing key rotation"));
    await h.deliver();

    const found = await hitsOf(await mine.searchSessions("signing key rotation"));

    expect(found.map((hit) => hit.session.sessionId)).toEqual(["s-mine"]);
  });
});

describe("indexing off the storage event", () => {
  // Indexing picks a session up where it left it, so a session that goes on writing is caught up
  // a stretch at a time rather than read from the start again — and an event delivered a second
  // time, which the queue promises will happen, indexes nothing twice.
  it("indexes what has arrived since the last pass, and nothing twice", async () => {
    const h = await harness();
    const userId = `indexer-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-long");
    const first = named("rogiffavof") + about("the offset table");
    await client.archive("s-long", "main", 0, first);
    await h.deliver();
    const indexed = await h.chunks(userId, "s-long");
    expect(indexed.length).toBeGreaterThan(0);

    await client.archive("s-long", "main", bytes(first), about("the labels tab"));
    await h.deliver();

    const grown = await h.chunks(userId, "s-long");
    expect(grown.slice(0, indexed.length)).toEqual(indexed);
    expect(grown.length).toBeGreaterThan(indexed.length);
    await h.deliver();
    expect(await h.chunks(userId, "s-long")).toEqual(grown);
    expect((await hitsOf(await client.searchSessions("the labels tab")))[0]?.session.sessionId).toBe("s-long");
  });

  // The failure that would otherwise take the index down for every account at once. One delivery
  // carries the stretches of several sessions, so a transcript the indexer cannot get through
  // would fail the delivery and hold back everything in it; each session is caught on its own
  // instead, keeps its own mark where it was, and sends its own messages back for redelivery.
  // Nothing else asks what is behind, so a session that acked a failure would never be indexed.
  it("sends back the messages of a session it cannot get through, and indexes the rest", async () => {
    const h = await harness();
    const userId = `wounded-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-aaa-poisoned");
    await client.archive("s-aaa-poisoned", "main", 0, named("rogiffavof") + about(`${UNEMBEDDABLE} wreckage`));
    await client.sync("s-zzz-healthy");
    await client.archive("s-zzz-healthy", "main", 0, named("minuksijaj") + about("the labels tab"));

    await h.deliver();

    expect(await h.chunks(userId, "s-zzz-healthy")).not.toEqual([]);
    expect(await h.chunks(userId, "s-aaa-poisoned")).toEqual([]);
    const poisoned = await h.indexMark(userId, "s-aaa-poisoned");
    expect(poisoned?.bytes).toBe(0);
    expect(poisoned?.archived).toBeGreaterThan(0);
    expect(h.retried()).toBe(1);
    await h.deliver();
    expect(await h.chunks(userId, "s-zzz-healthy")).not.toEqual([]);
    expect(await h.chunks(userId, "s-aaa-poisoned")).toEqual([]);
  });

  // An object the archive lost. Its bytes exist nowhere and never will, and the row the appends
  // wrote counts them, so the mark the indexer leaves stands short of it for good. The pass that
  // finds nothing past where it has read stops rather than asking for those bytes on every event.
  it("steps over a stretch the archive lost rather than stalling on it", async () => {
    const h = await harness();
    const userId = `holed-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-holed");
    const head = named("nufogruzup") + about("the offset table");
    const lost = about("a stretch that never landed");
    const tail = about("the labels tab");
    await client.archive("s-holed", "main", 0, head);
    await client.archive("s-holed", "main", bytes(head), lost);
    await client.archive("s-holed", "main", bytes(head) + bytes(lost), tail);
    const keys = await env.TRANSCRIPTS.list({ prefix: `${userId}/s-holed/main/` });
    await env.TRANSCRIPTS.delete(keys.objects[1]?.key ?? "");

    await h.deliver();

    const mark = await h.indexMark(userId, "s-holed");
    expect(mark?.bytes).toBe(bytes(head) + bytes(tail));
    expect(mark?.archived).toBe(bytes(head) + bytes(lost) + bytes(tail));
    const chunks = await h.chunks(userId, "s-holed");
    await h.deliver();
    expect(await h.chunks(userId, "s-holed")).toEqual(chunks);
    expect(chunks.some((text) => text.includes("the offset table"))).toBe(true);
    expect(chunks.some((text) => text.includes("the labels tab"))).toBe(true);
    expect(chunks.some((text) => text.includes("never landed"))).toBe(false);
    expect((await hitsOf(await client.searchSessions("the labels tab")))[0]?.session.sessionId).toBe("s-holed");
  });
});

describe("restoring a stored session", () => {
  it("reads a transcript file back whole, however many stretches it arrived in", async () => {
    const h = await harness();
    const client = await h.user("restorer");
    await client.sync("s-restore");
    const whole = named("nufogruzup") + about("the restore path");
    const head = whole.slice(0, Math.floor(whole.length / 2));
    await client.archive("s-restore", "main", 0, head);
    await client.archive("s-restore", "main", bytes(head), whole.slice(head.length));
    await client.archive("s-restore", "agent-7f21", 0, answer("a delegated turn"));

    const read = await client.readTranscript("s-restore", "main");

    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await read.text()).toBe(whole);
    const stored = (await (await client.session("s-restore")).json()) as { files: Array<{ file: string }> };
    expect(stored.files.map((file) => file.file)).toEqual(["agent-7f21", "main"]);
    expect((await client.readTranscript("s-restore", "agent-9999")).status).toBe(404);
  });
});
