import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessVerifier, type KeySource, localKeys } from "../src/access";
import { createApp } from "../src/app";
import type { Embedder, Memory } from "../src/model";
import { DIMENSIONS, normalize } from "../src/rank";

const ISSUER = "https://recall-test.cloudflareaccess.com";
const AUDIENCE = "recall-test-aud";

// Embeds plain words only: tokens holding a digit are invisible to it, the way
// rare identifiers barely register with a real embedding model.
const wordEmbedder: Embedder = {
  async embed(text: string): Promise<Float32Array> {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (/[0-9]/.test(word)) continue;
      let hash = 0;
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      vector[hash % DIMENSIONS] = (vector[hash % DIMENSIONS] ?? 0) + 1;
    }
    return normalize(vector);
  },
};

export type Mode = "hybrid" | "vector" | "text";

export interface Hit {
  memory: Memory;
  score: number;
}

export interface Client {
  request(method: string, path: string, body?: unknown): Promise<Response>;
  save(name: string, fields: Partial<Pick<Memory, "description" | "type" | "body" | "tags">>): Promise<Memory>;
  get(name: string): Promise<Memory>;
  search(query: string, tags: string[] | "any", mode?: Mode): Promise<Hit[]>;
}

export const harness = async (keys: "up" | "down" = "up") => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const { n, e } = await exportJWK(publicKey);
  if (!n || !e) throw new Error("the generated key has no RSA modulus");
  const unavailable: KeySource = {
    keys: () => Promise.reject(new Error("Access signing keys answered 503")),
    refresh: () => Promise.reject(new Error("Access signing keys answered 503")),
  };
  let clock = 1_700_000_000_000;
  const app = createApp({
    verify: accessVerifier(
      keys === "up" ? localKeys([{ kid: "test", kty: "RSA", n, e }]) : unavailable,
      ISSUER,
      AUDIENCE,
    ),
    embedder: wordEmbedder,
    now: () => clock,
  });

  const assertionFor = (clientId: string, audience = AUDIENCE, expiresAt: string | number = "5m"): Promise<string> =>
    new SignJWT({ common_name: clientId, type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(ISSUER)
      .setAudience([audience])
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(privateKey);

  const clientWithAssertion = (assertion: string): Client => {
    const request = async (method: string, path: string, body?: unknown): Promise<Response> =>
      app.fetch(
        new Request(`https://recall.test${path}`, {
          method,
          headers: { "cf-access-jwt-assertion": assertion, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        env,
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
      async get(name) {
        const response = await request("GET", `/v1/memories/${name}`);
        if (response.status !== 200) throw new Error(`get ${name}: ${response.status} ${await response.text()}`);
        const found: { memory: Memory } = await response.json();
        return found.memory;
      },
      async search(query, tags, mode = "hybrid") {
        const response = await request("POST", "/v1/search", {
          query,
          tags: tags === "any" ? [] : tags,
          any: tags === "any",
          limit: 10,
          minScore: 0.1,
          mode,
        });
        if (response.status !== 200) throw new Error(`search: ${response.status} ${await response.text()}`);
        const result: { hits: Hit[] } = await response.json();
        return result.hits;
      },
    };
  };

  const user = async (label: string): Promise<Client> => {
    const clientId = `${crypto.randomUUID()}.access`;
    await env.DB.prepare("INSERT INTO principals (client_id, user_id) VALUES (?, ?)")
      .bind(clientId, `${label}-${crypto.randomUUID()}`)
      .run();
    return clientWithAssertion(await assertionFor(clientId));
  };

  return {
    user,
    clientWithAssertion,
    assertionFor,
    tick: (ms: number) => {
      clock += ms;
      return clock;
    },
    now: () => clock,
  };
};
