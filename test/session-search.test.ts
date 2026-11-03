import { describe, expect, it } from "vitest";
import { IDLE_AFTER_MS, type PastSession, type SessionHit } from "../src/model";
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

// The session document the harness syncs is last active a minute after the clock it starts on.
const QUIET = IDLE_AFTER_MS + 120_000;

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
    await client.archive(id, "main", 0, named("kisuvpalas") + prompt("rotate the signing key"));

    const session = await sessionOf(await client.session("kisuvpalas"));

    expect(session.sessionId).toBe(id);
    expect(session.agentName).toBe("kisuvpalas");
    expect(session.cwd).toBe("/home/you/src/recall");
    expect((await sessionOf(await client.session(id))).agentName).toBe("kisuvpalas");
    expect((await sessionOf(await client.session(session.name))).sessionId).toBe(id);
    expect((await client.session("nobody-here")).status).toBe(404);
  });

  // A transcript whose name entry lands past the first stretch, which is every session archived
  // before the append path learned to read one. The indexing pass reads the head again and names
  // it, so nothing has to be sent twice.
  it("names a session the archive never named, on its first indexing pass", async () => {
    const h = await harness();
    const client = await h.user("latecomer");
    const head = prompt("a first stretch with no name in it");
    await client.sync("s-unnamed");
    await client.archive("s-unnamed", "main", 0, head);
    await client.archive("s-unnamed", "main", bytes(head), named("dubikrimaz") + about("the offset table"));
    expect((await sessionOf(await client.session("s-unnamed"))).agentName).toBe("");

    h.tick(QUIET);
    await h.index();

    expect((await sessionOf(await client.session("dubikrimaz"))).sessionId).toBe("s-unnamed");
  });

  it("answers no caller the session does not belong to", async () => {
    const h = await harness();
    const owner = await h.user("keeper");
    const stranger = await h.user("passerby");
    await owner.sync("s-private");
    await owner.archive("s-private", "main", 0, named("vatoglojaf") + prompt("nothing to see"));

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
    h.tick(QUIET);
    await h.index();

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
    h.tick(QUIET);
    await h.index();
    await h.index();

    const found = await hitsOf(await mine.searchSessions("signing key rotation"));

    expect(found.map((hit) => hit.session.sessionId)).toEqual(["s-mine"]);
  });

  // Indexing runs on a beat of its own and picks a session up where it left it, so a session that
  // goes on writing is caught up a stretch at a time rather than read from the start again.
  it("indexes what has arrived since the last pass, and nothing twice", async () => {
    const h = await harness();
    const userId = `indexer-${crypto.randomUUID()}`;
    const client = h.clientWithToken(await h.login(await h.invite(`${userId}@example.com`, userId)));
    await client.sync("s-long");
    const first = named("rogiffavof") + about("the offset table");
    await client.archive("s-long", "main", 0, first);
    h.tick(QUIET);
    await h.index();
    const indexed = await h.chunks(userId, "s-long");
    expect(indexed.length).toBeGreaterThan(0);

    await client.archive("s-long", "main", bytes(first), about("the labels tab"));
    h.tick(QUIET);
    await h.index();

    const grown = await h.chunks(userId, "s-long");
    expect(grown.slice(0, indexed.length)).toEqual(indexed);
    expect(grown.length).toBeGreaterThan(indexed.length);
    await h.index();
    expect(await h.chunks(userId, "s-long")).toEqual(grown);
    expect((await hitsOf(await client.searchSessions("the labels tab")))[0]?.session.sessionId).toBe("s-long");
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
