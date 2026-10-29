import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessVerifier, type KeySource, localKeys } from "../src/access";
import { createApp } from "../src/app";
import type { Embedder, Memory } from "../src/model";
import { DIMENSIONS, normalize } from "../src/rank";

const ISSUER = "https://recall-test.cloudflareaccess.com";
const AUDIENCE = "recall-test-aud";
const ORIGIN = "https://recall.test";

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

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

  const assertionFor = (email: string, audience = AUDIENCE, expiresAt: string | number = "5m"): Promise<string> =>
    new SignJWT({ email, type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(ISSUER)
      .setAudience([audience])
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(privateKey);

  const send = (path: string, init: RequestInit = {}): Promise<Response> =>
    app.fetch(new Request(`${ORIGIN}${path}`, init), env);

  const startDevice = async (deviceName = "laptop"): Promise<DeviceStart> => {
    const response = await send("/v1/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_name: deviceName }),
    });
    if (response.status !== 200) throw new Error(`device code: ${response.status} ${await response.text()}`);
    return response.json();
  };

  const poll = (deviceCode: string): Promise<Response> =>
    send("/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      }),
    });

  const openApproval = (userCode: string, assertion: string | null): Promise<Response> =>
    send(`/device?code=${encodeURIComponent(userCode)}`, {
      headers: assertion === null ? {} : { "cf-access-jwt-assertion": assertion },
    });

  const csrfOf = async (response: Response): Promise<string> => {
    const match = /name="csrf" value="([^"]+)"/.exec(await response.text());
    if (!match?.[1]) throw new Error(`the approval page shows no form: ${response.status}`);
    return match[1];
  };

  const decide = async (
    userCode: string,
    action: "approve" | "deny",
    assertion: string | null,
    csrf?: string,
  ): Promise<Response> => {
    const token = csrf ?? (await csrfOf(await openApproval(userCode, assertion)));
    return send("/device", {
      method: "POST",
      headers: {
        ...(assertion === null ? {} : { "cf-access-jwt-assertion": assertion }),
        origin: ORIGIN,
        cookie: `__Host-recall_csrf=${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ user_code: userCode, action, csrf: token }),
    });
  };

  const login = async (email: string, deviceName = "laptop"): Promise<string> => {
    const started = await startDevice(deviceName);
    const approved = await decide(started.user_code, "approve", await assertionFor(email));
    if (approved.status !== 200) throw new Error(`approve: ${approved.status} ${await approved.text()}`);
    clock += started.interval * 1000;
    const response = await poll(started.device_code);
    if (response.status !== 200) throw new Error(`token: ${response.status} ${await response.text()}`);
    const granted: { access_token: string } = await response.json();
    return granted.access_token;
  };

  const clientWithHeaders = (headers: Record<string, string>): Client => {
    const request = async (method: string, path: string, body?: unknown): Promise<Response> =>
      send(path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
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

  const clientWithToken = (token: string): Client => clientWithHeaders({ authorization: `Bearer ${token}` });

  const user = async (label: string): Promise<Client> =>
    clientWithToken(await login(`${label}-${crypto.randomUUID()}@example.com`));

  return {
    user,
    send,
    login,
    startDevice,
    poll,
    openApproval,
    csrfOf,
    decide,
    clientWithToken,
    clientWithHeaders,
    assertionFor,
    tick: (ms: number) => {
      clock += ms;
      return clock;
    },
    now: () => clock,
  };
};
