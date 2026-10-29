import type { Verification, Verify } from "./model";

const KEY_TTL_SECONDS = 3600;
const REFRESH_FLOOR_MS = 60_000;
const CLOCK_LEEWAY_S = 60;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

export interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

export interface KeySource {
  keys(): Promise<Map<string, CryptoKey>>;
  refresh(): Promise<Map<string, CryptoKey> | null>;
}

const isJwk = (value: unknown): value is Jwk =>
  typeof value === "object" &&
  value !== null &&
  "kid" in value &&
  typeof value.kid === "string" &&
  "kty" in value &&
  value.kty === "RSA" &&
  "n" in value &&
  typeof value.n === "string" &&
  "e" in value &&
  typeof value.e === "string";

const parseKeySet = (text: string): Jwk[] => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("keys" in parsed) || !Array.isArray(parsed.keys)) {
    throw new Error("Access signing keys hold no keys array");
  }
  return parsed.keys.filter(isJwk);
};

const importKeys = async (jwks: Jwk[]): Promise<Map<string, CryptoKey>> =>
  new Map(
    await Promise.all(
      jwks.map(
        async (jwk): Promise<[string, CryptoKey]> => [
          jwk.kid,
          await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" }, RS256, false, [
            "verify",
          ]),
        ],
      ),
    ),
  );

export const localKeys = (jwks: Jwk[]): KeySource => {
  const keys = importKeys(jwks);
  return { keys: () => keys, refresh: async () => null };
};

// Keys live in module scope for the isolate and in the colo's Cache API for an
// hour, so a fresh isolate reads them locally instead of fetching from Access.
export const cachedAccessKeys = (certsUrl: string): KeySource => {
  let current: { keys: Map<string, CryptoKey>; loadedAt: number } | null = null;

  const fromOrigin = async (): Promise<Jwk[]> => {
    const response = await fetch(certsUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Access signing keys at ${certsUrl} answered ${response.status}`);
    const body = await response.text();
    const jwks = parseKeySet(body);
    await caches.default.put(
      certsUrl,
      new Response(body, {
        headers: { "content-type": "application/json", "cache-control": `max-age=${KEY_TTL_SECONDS}` },
      }),
    );
    return jwks;
  };

  const fromCache = async (): Promise<Jwk[] | null> => {
    const cached = await caches.default.match(certsUrl);
    return cached ? parseKeySet(await cached.text()) : null;
  };

  const load = async (jwks: Jwk[]): Promise<Map<string, CryptoKey>> => {
    const keys = await importKeys(jwks);
    current = { keys, loadedAt: Date.now() };
    return keys;
  };

  return {
    async keys() {
      if (current && Date.now() - current.loadedAt < KEY_TTL_SECONDS * 1000) return current.keys;
      return load((await fromCache()) ?? (await fromOrigin()));
    },
    async refresh() {
      if (current && Date.now() - current.loadedAt < REFRESH_FLOOR_MS) return null;
      return load(await fromOrigin());
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeBase64Url = (segment: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(segment) || segment.length % 4 === 1) return null;
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
};

const decodeJson = (segment: string): Record<string, unknown> | null => {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const audienceMatches = (claim: unknown, audience: string): boolean =>
  claim === audience || (Array.isArray(claim) && claim.includes(audience));

const reject = (reason: string): Verification => ({ ok: false, reason });

export const accessVerifier =
  (source: KeySource, issuer: string, audience: string): Verify =>
  async (assertion: string): Promise<Verification> => {
    const [headerSegment, payloadSegment, signatureSegment, ...extra] = assertion.split(".");
    if (headerSegment === undefined || payloadSegment === undefined || signatureSegment === undefined || extra.length) {
      return reject("the assertion is not a JWT");
    }
    const header = decodeJson(headerSegment);
    const payload = decodeJson(payloadSegment);
    const signature = decodeBase64Url(signatureSegment);
    if (!header || !payload || !signature) return reject("the JWT is malformed");
    if (header.alg !== "RS256" || typeof header.kid !== "string") return reject("the JWT is not signed with RS256");

    const key = (await source.keys()).get(header.kid) ?? (await source.refresh())?.get(header.kid) ?? null;
    if (!key) return reject("the JWT is signed by a key Access does not publish");
    const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
    if (!(await crypto.subtle.verify(RS256, key, signature, signed)))
      return reject("the JWT signature does not verify");

    const nowS = Date.now() / 1000;
    if (payload.iss !== issuer) return reject("the JWT was issued by another Access team");
    if (!audienceMatches(payload.aud, audience)) return reject("the JWT is meant for another Access application");
    if (typeof payload.exp !== "number" || payload.exp + CLOCK_LEEWAY_S <= nowS) return reject("the JWT has expired");
    if (typeof payload.nbf === "number" && payload.nbf - CLOCK_LEEWAY_S > nowS)
      return reject("the JWT is not valid yet");
    const email = payload.email;
    if (typeof email !== "string" || !email.includes("@")) {
      return reject("the JWT carries no email; sign in to Access with a one-time PIN");
    }
    return { ok: true, email: email.toLowerCase() };
  };
