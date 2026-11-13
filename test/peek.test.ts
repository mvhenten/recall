import { describe, expect, it } from "vitest";
import {
  NO_PEEK_LISTENING,
  ORDERS,
  ORDERS_HEADER,
  type Outcome,
  type PeekFrame,
  type PeekOrder,
  type Receipt,
} from "../src/mailbox";
import { PEEK_FRESH_MS } from "../src/tools";
import type { V2Peek } from "../src/v2";
import { type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

interface Asked {
  peek: V2Peek;
  outcome: Outcome;
}

// What a host writes back about each peek it is handed, standing in for the daemon starting the
// summariser: that it is running the session, or that it has none by that name. A host that writes
// nothing leaves the ask to give up when its window closes.
type Answer = (frame: PeekFrame) => Receipt | null;

const summarising: Answer = (frame) => ({
  type: "peek-took",
  peekId: frame.peek.peekId,
  token: frame.token,
});

// A session the peek names and the host runs, registered as that host so the peek has somewhere to
// go and the digest has a row to land on.
const peeking = async () => {
  const h = await harness();
  const userId = `user-${crypto.randomUUID()}`;
  const email = await h.invite(`${userId}@example.com`, userId);
  const token = await h.login(email, "laptop");
  const laptop = h.clientWithToken(token, userId);
  const sessionId = `laptop-${crypto.randomUUID()}`;
  expect((await laptop.v2.sync(sessionId)).status).toBe(204);
  return { h, userId, email, laptop, token, sessionId };
};

// The peeks one listening host is handed, in the order they reached it.
const listen = async (h: Harness, token: string, answer: Answer): Promise<PeekOrder[]> => {
  const response = await h.send("/v2/messages/listen", {
    headers: { authorization: `Bearer ${token}`, upgrade: "websocket", [ORDERS_HEADER]: ORDERS },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("the listen upgrade carried no socket");
  socket.accept();
  const handed: PeekOrder[] = [];
  socket.addEventListener("message", (event) => {
    const frame: PeekFrame = JSON.parse(String(event.data));
    if (frame.type !== "peek") return;
    handed.push(frame.peek);
    const reply = answer(frame);
    if (reply !== null) socket.send(JSON.stringify(reply));
  });
  return handed;
};

const ask = async (client: Client, sessionId: string): Promise<Asked> => {
  const response = await client.request("POST", `/v2/sessions/${sessionId}/peek`);
  expect(response.status).toBe(201);
  return await response.json();
};

const write = (client: Client, sessionId: string, peekId: string, digest: string): Promise<Response> =>
  client.request("PUT", `/v2/sessions/${sessionId}/peek/${peekId}`, { digest });

const history = async (client: Client, sessionId: string): Promise<V2Peek[]> => {
  const response = await client.request("GET", `/v2/sessions/${sessionId}/peek`);
  expect(response.status).toBe(200);
  const read: { peeks: V2Peek[] } = await response.json();
  return read.peeks;
};

describe("peeks", () => {
  it("writes the peek pending and hands the host one naming the session to summarise", async () => {
    const { h, laptop, token, sessionId } = await peeking();
    const handed = await listen(h, token, summarising);

    const { peek: asked, outcome } = await ask(laptop, sessionId);

    expect(asked.state).toBe("Pending");
    expect(asked.digest).toBe("");
    expect(asked.requestedAt).toMatch(OFFSET);
    expect(outcome).toEqual({ state: "taken", sessionId });
    expect(handed).toHaveLength(1);
    expect(handed[0]?.peekId).toBe(asked.peekId);
    expect(handed[0]?.sessionId).toBe(sessionId);
    expect(handed[0]?.requestedAt).toBe(h.now());
    expect(await history(laptop, sessionId)).toEqual([asked]);
  });

  // The row is the asker's and the digest is the host's, so a peek nobody takes is still a row the
  // asker reads back. It says pending, which is what it is.
  it("keeps the peek it wrote when no host is listening and tells the asker so", async () => {
    const { laptop, sessionId } = await peeking();

    const { peek: asked, outcome } = await ask(laptop, sessionId);

    expect(outcome).toEqual({ state: "untaken", reason: NO_PEEK_LISTENING });
    expect(await history(laptop, sessionId)).toEqual([{ ...asked, state: "Pending", digest: "" }]);
  });

  it("takes the first digest a summariser writes and refuses the one behind it", async () => {
    const { h, laptop, token, sessionId } = await peeking();
    await listen(h, token, summarising);
    const { peek: asked } = await ask(laptop, sessionId);

    expect((await write(laptop, sessionId, asked.peekId, "running the tenant migration")).status).toBe(204);
    const second = await write(laptop, sessionId, asked.peekId, "reading the transcript");
    expect(second.status).toBe(409);

    expect(await history(laptop, sessionId)).toEqual([
      { ...asked, state: "Ready", digest: "running the tenant migration" },
    ]);
  });

  it("reads the history newest first and says of each peek what its digest says", async () => {
    const { h, laptop, token, sessionId } = await peeking();
    await listen(h, token, summarising);
    const { peek: first } = await ask(laptop, sessionId);
    expect((await write(laptop, sessionId, first.peekId, "running the tenant migration")).status).toBe(204);
    // An ask inside the freshness bound is answered off the digest already on record, so the
    // second peek of this history is asked for once that bound has passed.
    h.advance(PEEK_FRESH_MS);
    const { peek: second } = await ask(laptop, sessionId);

    const read = await history(laptop, sessionId);

    expect(read.map((held) => [held.peekId, held.state, held.digest])).toEqual([
      [second.peekId, "Pending", ""],
      [first.peekId, "Ready", "running the tenant migration"],
    ]);
  });

  // The session a caller reads carries its own peeks, so reading what one session was about costs
  // one call and not a second one behind it.
  it("carries the peeks on the session they were asked of, newest first", async () => {
    const { h, laptop, token, sessionId } = await peeking();
    await listen(h, token, summarising);
    const { peek: first } = await ask(laptop, sessionId);
    expect((await write(laptop, sessionId, first.peekId, "running the tenant migration")).status).toBe(204);
    h.advance(PEEK_FRESH_MS);
    const { peek: second } = await ask(laptop, sessionId);

    const read = (await (await laptop.v2.session(sessionId)).json()) as { peeks: V2Peek[] };

    expect(read.peeks).toEqual([
      { ...second, state: "Pending", digest: "" },
      { ...first, state: "Ready", digest: "running the tenant migration" },
    ]);
  });

  // A summariser that finishes after its peek fell out of the history has nowhere to write, and is
  // told that rather than left to read a 500 as a host it should try again.
  it("tells a summariser that the peek it answers is not held", async () => {
    const { laptop, sessionId } = await peeking();

    const refused = await write(laptop, sessionId, crypto.randomUUID(), "running the tenant migration");

    expect(refused.status).toBe(404);
    const { error }: { error: string } = await refused.json();
    expect(error).toContain("no peek");
  });

  // The summariser reads a transcript that lives on one host. Another device signed in to the same
  // account holds none of it, so what it would write is not a summary of that session.
  it("takes the digest from the device the session runs on and from no other", async () => {
    const { h, laptop, token, sessionId, email } = await peeking();
    await listen(h, token, summarising);
    const { peek: asked } = await ask(laptop, sessionId);
    const desktop = h.clientWithToken(await h.login(email, "desktop"));

    const refused = await write(desktop, sessionId, asked.peekId, "running the tenant migration");

    expect(refused.status).toBe(404);
    expect(await history(laptop, sessionId)).toEqual([{ ...asked, state: "Pending", digest: "" }]);
  });

  it("refuses a digest of no characters, which would leave the peek reading pending", async () => {
    const { h, laptop, token, sessionId } = await peeking();
    await listen(h, token, summarising);
    const { peek: asked } = await ask(laptop, sessionId);

    expect((await write(laptop, sessionId, asked.peekId, "")).status).toBe(400);
    expect(await history(laptop, sessionId)).toEqual([{ ...asked, state: "Pending", digest: "" }]);
  });
});
