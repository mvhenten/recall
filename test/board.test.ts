import { describe, expect, it } from "vitest";
import { BOARD_WINDOW_MS, type BoardEntry, type BoardMessage } from "../src/board";
import { type Client, harness } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

const ORIGIN = "https://recall.test";
const BOARD_PATH = "/dashboard/board";

const deviceId = async (client: Client, name: string): Promise<string> => {
  const response = await client.request("GET", "/v2/devices");
  const listed: { devices: { deviceId: string; name: string }[] } = await response.json();
  const device = listed.devices.find((candidate) => candidate.name === name);
  if (!device) throw new Error(`no device named ${name}`);
  return device.deviceId;
};

const postToFleet = async (client: Client, body: string): Promise<BoardMessage> => {
  const response = await client.request("POST", "/v2/board", { address: { scope: "fleet" }, body });
  expect(response.status).toBe(201);
  return await response.json();
};

const pickUp = async (client: Client, sessionId: string): Promise<BoardMessage[]> => {
  const response = await client.request("POST", "/v2/board/pickup", { sessionId });
  expect(response.status).toBe(200);
  const picked: { messages: BoardMessage[] } = await response.json();
  return picked.messages;
};

const readBoard = async (client: Client): Promise<BoardEntry[]> => {
  const response = await client.request("GET", "/v2/board");
  expect(response.status).toBe(200);
  const page: { entries: BoardEntry[] } = await response.json();
  return page.entries;
};

const account = async (h: Harness, userId: string): Promise<{ laptop: Client; desktop: Client }> => {
  const email = await h.invite(`${userId}@example.com`, userId);
  return {
    laptop: h.clientWithToken(await h.login(email, "laptop")),
    desktop: h.clientWithToken(await h.login(email, "desktop")),
  };
};

describe("the board", () => {
  // The bug the bus rework was for: one message, every session on every host answering it. Two
  // sessions booting at the same moment both run the claim, and the primary key on the pickup is
  // what gives the message to one of them.
  it("gives one fleet message to one of two sessions picking up at the same moment", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop, desktop } = await account(h, userId);
    const posted = await postToFleet(laptop, "rerun the migration");

    const [first, second] = await Promise.all([pickUp(laptop, "9f8a1b2c"), pickUp(desktop, "7e3d4a5b")]);

    const took = [...first, ...second].map((message) => message.messageId);
    expect(took).toEqual([posted.messageId]);
    expect(await pickUp(laptop, "a1b2c3d4")).toEqual([]);

    const [entry] = await readBoard(laptop);
    expect(entry?.state).toBe("taken");
  });

  it("holds a host message for the first session on that host and for nobody else", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop, desktop } = await account(h, userId);
    const desktopId = await deviceId(laptop, "desktop");
    const posted = await laptop.request("POST", "/v2/board", {
      address: { scope: "host", target: desktopId },
      body: "pull main",
    });
    expect(posted.status).toBe(201);

    expect(await pickUp(laptop, "9f8a1b2c")).toEqual([]);
    const took = await pickUp(desktop, "7e3d4a5b");
    expect(took.map((message) => message.body)).toEqual(["pull main"]);
    expect(await pickUp(desktop, "a1b2c3d4")).toEqual([]);
  });

  // The pickup is told which session is taking the messages, and a session-addressed message is
  // only ever taken from the host that session runs on: naming somebody else's session id takes
  // nothing and leaves the message waiting for the session it was posted to.
  it("takes a session message only on the device that session runs on", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop, desktop } = await account(h, userId);
    expect((await laptop.sync("9f8a1b2c")).status).toBe(204);
    const posted = await laptop.request("POST", "/v2/board", {
      address: { scope: "session", target: "9f8a1b2c" },
      body: "for the laptop session only",
    });
    expect(posted.status).toBe(201);

    expect(await pickUp(desktop, "9f8a1b2c")).toEqual([]);
    expect((await pickUp(laptop, "9f8a1b2c")).map((message) => message.body)).toEqual(["for the laptop session only"]);
  });

  // The start hook runs the pickup under a timeout, which kills it after the claim is written, so a
  // session reads back what it already took rather than losing the message to nobody. `SessionStart`
  // fires again on resume and on compact under the same session id, which is what brings it back.
  it("hands a session the messages it already took", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop, desktop } = await account(h, userId);
    await postToFleet(laptop, "rerun the migration");

    expect((await pickUp(laptop, "9f8a1b2c")).map((message) => message.body)).toEqual(["rerun the migration"]);
    expect((await pickUp(laptop, "9f8a1b2c")).map((message) => message.body)).toEqual(["rerun the migration"]);
    expect(await pickUp(desktop, "9f8a1b2c")).toEqual([]);
    expect(await pickUp(desktop, "7e3d4a5b")).toEqual([]);
  });

  // A message nobody booted into cannot haunt the fleet: past the window it is picked up by
  // nobody and reads on no listing, because the pickup and the listing both read inside it.
  it("stops holding a message once its week is up", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop } = await account(h, userId);
    await postToFleet(laptop, "a week ago");
    expect((await readBoard(laptop)).length).toBe(1);

    h.tick(BOARD_WINDOW_MS);
    expect(await pickUp(laptop, "9f8a1b2c")).toEqual([]);
    expect(await readBoard(laptop)).toEqual([]);

    await postToFleet(laptop, "still fresh");
    expect((await pickUp(laptop, "7e3d4a5b")).map((message) => message.body)).toEqual(["still fresh"]);
  });

  // The dashboard carries no device token, so the table is the only thing its post shares with
  // `recall post`: what the form writes is what a session picks up.
  it("takes the dashboard's own post onto the same board", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const address = `${userId}@example.com`;
    await h.invite(address, userId);
    const assertion = await h.assertionFor(address);
    const laptop = h.clientWithToken(await h.login(address, "laptop"));

    const page = await h.send(BOARD_PATH, { headers: { "cf-access-jwt-assertion": assertion } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csrf).not.toBe("");
    expect(html).toContain("The fleet");

    const posted = await h.send(BOARD_PATH, {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": assertion,
        origin: ORIGIN,
        cookie: (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ to: "fleet", body: "ship the release", csrf }),
    });
    expect(posted.status).toBe(303);

    const took = await pickUp(laptop, "9f8a1b2c");
    expect(took.map((message) => [message.body, message.fromName])).toEqual([["ship the release", address]]);
  });

  it("posts and picks up only for a caller on the addressed account", async () => {
    const h = await harness();
    const userId = `user-${crypto.randomUUID()}`;
    const { laptop } = await account(h, userId);
    const desktopId = await deviceId(laptop, "desktop");
    const bob = await h.user("bob");
    await postToFleet(laptop, "ours alone");

    expect(
      (await bob.request("POST", "/v2/board", { address: { scope: "host", target: desktopId }, body: "x" })).status,
    ).toBe(404);
    expect(await pickUp(bob, "9f8a1b2c")).toEqual([]);
    expect(await readBoard(bob)).toEqual([]);
  });
});
