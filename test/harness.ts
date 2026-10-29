import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessVerifier } from "../src/access";
import { createApp } from "../src/app";
import type { Embedder, Memory, VectorIndex, VectorMatch } from "../src/model";

const ISSUER = "https://recall-test.cloudflareaccess.com";
const AUDIENCE = "recall-test-aud";
const DIMENSIONS = 384;

const hashEmbedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let hash = 0;
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      vector[hash % DIMENSIONS] = (vector[hash % DIMENSIONS] ?? 0) + 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  },
};

// Ignores namespaces on purpose: every user's vectors come back from every query,
// so the tests prove that D1 alone keeps users apart.
export const sharedIndex = (): VectorIndex & { size(): number } => {
  const vectors = new Map<string, number[]>();
  return {
    async upsert(_namespace: string, id: string, values: number[]): Promise<void> {
      vectors.set(id, values);
    },
    async query(_namespace: string, values: number[], topK: number): Promise<VectorMatch[]> {
      return [...vectors.entries()]
        .map(([id, stored]) => ({ id, score: stored.reduce((sum, value, i) => sum + value * (values[i] ?? 0), 0) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
    async remove(ids: string[]): Promise<void> {
      for (const id of ids) vectors.delete(id);
    },
    size: () => vectors.size,
  };
};

export interface Client {
  request(method: string, path: string, body?: unknown): Promise<Response>;
  save(name: string, fields: Partial<SaveBody>): Promise<Memory>;
  search(query: string, tags: string[]): Promise<Array<{ memory: Memory; score: number }>>;
}

interface SaveBody {
  description: string;
  type: string;
  body: string;
  tags: string[];
}

export const harness = async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
  const index = sharedIndex();
  let clock = 1_700_000_000_000;
  const app = createApp({
    verify: accessVerifier(createLocalJWKSet({ keys: [jwk] }), ISSUER, AUDIENCE),
    embedder: hashEmbedder,
    index,
    now: () => clock,
  });

  const assertionFor = (clientId: string): Promise<string> =>
    new SignJWT({ common_name: clientId, type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  const clientWithAssertion = (assertion: string): Client => {
    const request = (method: string, path: string, body?: unknown): Promise<Response> =>
      Promise.resolve(
        app.request(
          path,
          {
            method,
            headers: { "cf-access-jwt-assertion": assertion, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
          env,
        ),
      );
    return {
      request,
      async save(name, fields) {
        const response = await request("PUT", `/v1/memories/${name}`, {
          description: `about ${name}`,
          type: "project",
          body: `notes on ${name}`,
          tags: [],
          ...fields,
        });
        if (response.status >= 300) throw new Error(`save ${name}: ${response.status} ${await response.text()}`);
        const saved: { memory: Memory } = await response.json();
        return saved.memory;
      },
      async search(query, tags) {
        const response = await request("POST", "/v1/search", { query, tags, limit: 10, minScore: -1 });
        if (response.status !== 200) throw new Error(`search: ${response.status} ${await response.text()}`);
        const result: { hits: Array<{ memory: Memory; score: number }> } = await response.json();
        return result.hits;
      },
    };
  };

  const user = async (userId: string): Promise<Client> => {
    const clientId = `${crypto.randomUUID()}.access`;
    await env.DB.prepare("INSERT INTO principals (client_id, user_id, host) VALUES (?, ?, ?)")
      .bind(clientId, userId, "test-host")
      .run();
    return clientWithAssertion(await assertionFor(clientId));
  };

  return {
    user,
    index,
    clientWithAssertion,
    assertionFor,
    tick: (ms: number) => {
      clock += ms;
      return clock;
    },
    now: () => clock,
  };
};
