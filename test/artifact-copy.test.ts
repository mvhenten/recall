import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ArtifactCopyReport } from "../src/artifact-copy";
import type { ArtifactView } from "../src/artifacts";
import { hashShareToken, newShareId, newShareToken, SHARE_LINK_PREFIX } from "../src/shares";
import { ARTIFACT_AUDIENCE, type Client, harness, tenantRows } from "./harness";

type Harness = Awaited<ReturnType<typeof harness>>;

// What the account published before artifacts moved, as rows of D1 and bytes of R2. The three
// text columns overlap deliberately: a ranking over one word has to put several rows in an order
// for comparing the two indexes to mean anything.
const CORPUS: ReadonlyArray<readonly [string, string, string]> = [
  ["rank-the-chunks", "bound the vector scan", "a search ranks the chunks it reads"],
  ["bound-the-scan", "rank the history rows", "the vector scan is bounded before it runs"],
  ["move-the-board", "rank the board", "the board moves into the object it belongs to"],
  ["write-the-migration", "write it once", "the migration is written once and applied once"],
  ["scan-the-archive", "scan it twice", "the archive is scanned twice and ranked once"],
];

// One word each. bm25 weighs a term by how rare it is across the whole index, and D1's index
// holds every account's artifacts where one object's holds one account's — for a single term that
// difference is one factor applied to every row alike, so the order survives it and a ranked
// comparison across the two stores says something.
const QUERIES = ["rank", "scan", "board", "migration", "archive"];

const RANKING = `SELECT a.artifact_seq AS seq FROM artifacts_fts f
   JOIN artifacts a ON a.artifact_seq = f.rowid
   WHERE artifacts_fts MATCH ?2 AND a.user_id = ?1
   ORDER BY bm25(artifacts_fts, 5.0, 2.0, 1.0) LIMIT 50`;

const INSERT_ARTIFACT = `INSERT INTO artifacts (user_id, name, rev, type, title, description, read_perm,
   write_perm, entry_path, files, file_count, bytes, created_at, updated_at, last_writer_user_id)
 VALUES (?1, ?2, ?3, 'site', ?4, ?5, ?6, 'owner', 'index.html', ?7, 1, ?8, ?9, ?9, ?1)`;

const INSERT_REVISION = "INSERT INTO artifact_revisions (user_id, name, rev_next) VALUES (?1, ?2, ?3)";

const INSERT_SHARE = `INSERT INTO artifact_shares (share_id, user_id, name, mode, subject, created_at,
   expires_at, last_used_at, uses) VALUES (?1, ?2, ?3, 'link', ?4, ?5, ?6, ?5, 0)`;

const AT = 1_700_000_000_000;

// Named for its account as well as its artifact, so a test over two accounts publishing one name
// can say which of the two a reader was served.
const bodyOf = (userId: string, name: string): string => `<p>${name} of ${userId}</p>`;

// One artifact exactly as the Worker left it in D1: the row, its revision counter and the bytes
// the row points at. Nothing writes this layout any more, so a test of the copy has to lay it
// down itself.
const seedArtifact = async (
  userId: string,
  name: string,
  title: string,
  description: string,
  read: "private" | "account" = "private",
  rev = 1,
): Promise<void> => {
  const body = bodyOf(userId, name);
  const bytes = new TextEncoder().encode(body).byteLength;
  const files = JSON.stringify([{ path: "index.html", bytes, contentType: "text/html; charset=utf-8" }]);
  await env.ARTIFACTS.put(`${userId}/${name}/${rev}/index.html`, body);
  await env.DB.prepare(INSERT_ARTIFACT).bind(userId, name, rev, title, description, read, files, bytes, AT).run();
  await env.DB.prepare(INSERT_REVISION).bind(userId, name, rev).run();
};

const seedCorpus = async (userId: string, tag: string): Promise<string[]> => {
  const names: string[] = [];
  for (const [name, title, description] of CORPUS) {
    const taken = `${name}-${tag}`;
    await seedArtifact(userId, taken, title, description);
    names.push(taken);
  }
  return names.sort();
};

const seedLinkShare = async (userId: string, name: string, now: number): Promise<string> => {
  const token = newShareToken();
  await env.DB.prepare(INSERT_SHARE)
    .bind(newShareId(), userId, name, await hashShareToken(token), now, now + 86_400_000)
    .run();
  return token;
};

const accountRanking = async (userId: string, query: string): Promise<number[]> => {
  const { results } = await env.DB.prepare(RANKING).bind(userId, query).all<{ seq: number }>();
  return results.map((row) => row.seq);
};

const tenantRanking = async (userId: string, query: string): Promise<number[]> =>
  (await tenantRows<{ seq: number }>(userId, RANKING, userId, query)).map((row) => row.seq);

const copy = async (client: Client): Promise<ArtifactCopyReport> => {
  const response = await client.request("POST", "/v1/artifacts/copy");
  expect(response.status).toBe(200);
  return response.json();
};

const listed = async (client: Client): Promise<string[]> => {
  const response = await client.request("GET", "/v1/artifacts?limit=50");
  expect(response.status).toBe(200);
  const page: { artifacts: ArtifactView[] } = await response.json();
  return page.artifacts.map((one) => one.name).sort();
};

const publisher = async (h: Harness, label: string): Promise<{ client: Client; assertion: string }> => {
  const userId = `user-${crypto.randomUUID()}`;
  const email = await h.invite(`${label}-${crypto.randomUUID()}@example.com`, userId);
  return {
    client: h.clientWithToken(await h.login(email), userId),
    assertion: await h.assertionFor(email, ARTIFACT_AUDIENCE),
  };
};

describe("copying the artifacts an account published before they moved", () => {
  it("brings every row over under the id its search index ranks by", async () => {
    const h = await harness();
    const { client } = await publisher(h, "alice");
    const names = await seedCorpus(client.userId, crypto.randomUUID().slice(0, 8));
    expect(await listed(client)).toEqual([]);

    const report = await copy(client);
    expect(report.userId).toBe(client.userId);
    expect(report.artifacts).toEqual({ copied: names.length, held: 0 });
    expect(report.revisions).toEqual({ copied: names.length, raised: 0, held: 0 });
    expect(report.names.claimed.sort()).toEqual(names);
    expect(report.names.heldElsewhere).toEqual([]);
    expect(report.names.contested).toEqual([]);
    expect(report.checks.rows).toEqual({ account: names.length, tenant: names.length });
    expect(report.checks.missing).toEqual([]);
    expect(report.checks.extra).toEqual([]);
    expect(report.checks.queries).toBeGreaterThan(0);
    expect(report.checks.ranking).toEqual([]);
    expect(report.checks.ok).toBe(true);

    expect(await listed(client)).toEqual(names);
    const seqs = await tenantRows<{ name: string; artifact_seq: number }>(
      client.userId,
      "SELECT name, artifact_seq FROM artifacts WHERE user_id = ?1 ORDER BY name",
      client.userId,
    );
    const { results } = await env.DB.prepare(
      "SELECT name, artifact_seq FROM artifacts WHERE user_id = ?1 ORDER BY name",
    )
      .bind(client.userId)
      .all<{ name: string; artifact_seq: number }>();
    expect(seqs).toEqual(results);
  });

  it("ranks the same query over the copy the way D1 ranked it", async () => {
    const h = await harness();
    const { client } = await publisher(h, "alice");
    await seedCorpus(client.userId, crypto.randomUUID().slice(0, 8));
    await copy(client);

    let ordered = 0;
    for (const query of QUERIES) {
      const was = await accountRanking(client.userId, query);
      expect(was, query).not.toEqual([]);
      expect(await tenantRanking(client.userId, query), query).toEqual(was);
      if (was.length > 1) ordered += 1;
    }
    expect(ordered).toBeGreaterThan(0);
  });

  it("gives every live share back the artifact it pointed at", async () => {
    const h = await harness();
    const { client } = await publisher(h, "alice");
    const [name] = await seedCorpus(client.userId, crypto.randomUUID().slice(0, 8));
    if (name === undefined) throw new Error("the corpus seeded no artifact");
    const token = await seedLinkShare(client.userId, name, h.now());

    const dead = await h.sendToSharePrefix(`${SHARE_LINK_PREFIX}/${token}`, null);
    expect(dead.status).toBe(404);

    const report = await copy(client);
    expect(report.checks.shares).toBe(1);
    expect(report.checks.resolution).toEqual([]);

    const live = await h.sendToSharePrefix(`${SHARE_LINK_PREFIX}/${token}`, null);
    expect(live.status).toBe(200);
    expect(await live.text()).toContain(name);
  });

  it("copies nothing the second time and writes no second row", async () => {
    const h = await harness();
    const { client } = await publisher(h, "alice");
    const names = await seedCorpus(client.userId, crypto.randomUUID().slice(0, 8));
    await copy(client);

    const again = await copy(client);
    expect(again.artifacts).toEqual({ copied: 0, held: names.length });
    expect(again.revisions).toEqual({ copied: 0, raised: 0, held: names.length });
    expect(again.names.claimed.sort()).toEqual(names);
    expect(again.checks.ok).toBe(true);

    const counted = await tenantRows<{ n: number }>(
      client.userId,
      `SELECT (SELECT count(*) FROM artifacts WHERE user_id = ?1)
         + (SELECT count(*) FROM artifact_revisions WHERE user_id = ?1) AS n`,
      client.userId,
    );
    expect(counted).toEqual([{ n: names.length * 2 }]);
    expect(await listed(client)).toEqual(names);
  });

  // The counter never goes back: a publish made after the cutover claimed revision 1 of a name
  // whose D1-era publishes had already streamed bytes into several, and handing that number out
  // again would write into a revision a reader can reach.
  it("raises a revision counter the object is behind on and leaves the row it already holds", async () => {
    const h = await harness();
    const { client } = await publisher(h, "alice");
    const tag = crypto.randomUUID().slice(0, 8);
    const name = `burn-up-${tag}`;
    expect((await client.publish(name, "<p>published after the cutover</p>")).status).toBe(200);
    await seedArtifact(client.userId, name, "an older title", "from before the cutover", "private", 6);
    await env.DB.prepare("UPDATE artifact_revisions SET rev_next = 7 WHERE user_id = ?1 AND name = ?2")
      .bind(client.userId, name)
      .run();

    const report = await copy(client);
    expect(report.artifacts).toEqual({ copied: 0, held: 1 });
    expect(report.revisions).toEqual({ copied: 0, raised: 1, held: 0 });

    const rows = await tenantRows<{ rev_next: number }>(
      client.userId,
      "SELECT rev_next FROM artifact_revisions WHERE user_id = ?1 AND name = ?2",
      client.userId,
      name,
    );
    expect(rows).toEqual([{ rev_next: 7 }]);
    const held = await client.request("GET", `/v1/artifacts/${name}`);
    const { artifact }: { artifact: ArtifactView } = await held.json();
    expect(artifact.title).toBe(name);
  });

  it("claims the name of every artifact it copies, so another account reaches an account-readable one", async () => {
    const h = await harness();
    const { client: alice } = await publisher(h, "alice");
    const { assertion: bob } = await publisher(h, "bob");
    const name = `quarterly-${crypto.randomUUID().slice(0, 8)}`;
    await seedArtifact(alice.userId, name, "the quarter", "what the quarter did", "account");

    expect((await h.sendToArtifactHost(`/a/${name}`, bob)).status).toBe(404);
    expect((await copy(alice)).names.claimed).toEqual([name]);

    const served = await h.sendToArtifactHost(`/a/${name}`, bob);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(bodyOf(alice.userId, name));
  });

  // Two accounts publishing one name for the whole account to read is a state D1 allowed and the
  // address space cannot hold: the hostname has no user segment. The resolver this replaces broke
  // the tie by user id. Nothing here breaks it.
  it("leaves a name two accounts publish account-readable claimed by neither", async () => {
    const h = await harness();
    const { client: alice, assertion: aliceReads } = await publisher(h, "alice");
    const { client: bob, assertion: bobReads } = await publisher(h, "bob");
    const { assertion: carol } = await publisher(h, "carol");
    const name = `report-${crypto.randomUUID().slice(0, 8)}`;
    await seedArtifact(alice.userId, name, "alice's report", "written by alice", "account");
    await seedArtifact(bob.userId, `${name}-of-bobs`, "bob's other report", "also bob's", "private");
    await seedArtifact(bob.userId, name, "bob's report", "written by bob", "account");

    const first = await copy(alice);
    expect(first.names.contested).toEqual([name]);
    expect(first.names.claimed).toEqual([]);
    const second = await copy(bob);
    expect(second.names.contested).toEqual([name]);
    expect(second.names.claimed).toEqual([`${name}-of-bobs`]);

    const claims = await env.DB.prepare("SELECT user_id FROM artifact_names WHERE name = ?1").bind(name).all();
    expect(claims.results).toEqual([]);

    // Both artifacts arrived, and each account still reaches its own. Nobody else reaches either.
    expect(first.checks.ok).toBe(true);
    expect(second.checks.ok).toBe(true);
    expect(await (await h.sendToArtifactHost(`/a/${name}`, aliceReads)).text()).toBe(bodyOf(alice.userId, name));
    expect(await (await h.sendToArtifactHost(`/a/${name}`, bobReads)).text()).toBe(bodyOf(bob.userId, name));
    expect((await h.sendToArtifactHost(`/a/${name}`, carol)).status).toBe(404);
  });
});
