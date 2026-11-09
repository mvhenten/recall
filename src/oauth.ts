import { and, eq, lte } from "drizzle-orm";
import type { AccountDb } from "./db";
import { randomToken, sameSecret, sha256Hex } from "./device";
import { MCP_PATH } from "./mcp";
import { oauthClients, oauthCodes, oauthRequests, oauthTokens } from "./schema/account";

// The OAuth surface a web MCP client walks to reach the connector. Three of its four endpoints are
// machine to machine and carry no credential of ours at all: a client discovers the two metadata
// documents, registers itself, and redeems a code for a token. Only the consent step proves a
// person, and it proves one the way every other page here does — a Cloudflare Access sign-in whose
// assertion names an email — so this holds no password, no session and no identity provider.
//
// The tokens it issues are opaque and stored as digests, bound to the user who consented, to the
// client that registered, and to the one resource this deployment serves. Nothing here is a JWT:
// `/mcp` reads a bearer token by looking it up, so a revoke is a delete rather than a list the
// endpoint has to consult.

export const AUTHORIZE_PATH = "/oauth/authorize";
export const CONSENT_PATH = "/oauth/consent";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";

// RFC 9728 names the document after the resource's own path, and RFC 8414 names the authorization
// server's after its issuer. The issuer here is the origin and carries no path, so the second
// document sits at the bare address; the suffixed form is answered beside it, because a client
// that appends the resource path to both addresses would otherwise discover nothing.
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

// The one scope the connector grants, which is every tool it serves. A client asking for anything
// else is granted this and told so, rather than refused: a registration that cannot be completed
// is the failure mode that leaves a connector stuck with nothing to show the user.
export const SCOPE = "recall";

// Where a browser-side MCP client calls the connector and its metadata from. The endpoint answers
// its own origin and these, and no other: the Origin header is what keeps a page on some fourth
// host from driving the connector with the Access cookie of whoever is reading it.
export const CONNECTOR_ORIGINS = ["https://claude.ai", "https://chatgpt.com", "https://chat.mistral.ai"];

const REQUEST_TTL_MS = 600_000;
const CODE_TTL_MS = 120_000;
const ACCESS_TTL_MS = 3_600_000;
const REFRESH_TTL_MS = 2_592_000_000;
const CLIENT_NAME_LIMIT = 100;
const REDIRECT_URI_LIMIT = 10;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const resourceOf = (origin: string): string => `${origin}${MCP_PATH}`;

export const resourceMetadataUrl = (origin: string): string => `${origin}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`;

export const protectedResourceMetadata = (origin: string): unknown => ({
  resource: resourceOf(origin),
  authorization_servers: [origin],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "recall",
});

export const authorizationServerMetadata = (origin: string): unknown => ({
  issuer: origin,
  authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
  token_endpoint: `${origin}${TOKEN_PATH}`,
  registration_endpoint: `${origin}${REGISTER_PATH}`,
  scopes_supported: [SCOPE],
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: true,
  resource_indicators_supported: true,
});

export interface OauthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export interface AuthorizationRequest {
  requestId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export type Issued = { accessToken: string; refreshToken: string; expiresIn: number };

export type TokenOutcome = { ok: true; issued: Issued } | { ok: false; error: string; description: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const parsedUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

// A redirect address a public client may be sent back to. The scheme is the whole of the rule:
// every callback a hosted client publishes is HTTPS, a fragment is the client's own to add after
// the redirect, and credentials in the authority are never a callback. The code lands at an
// address the client registered and is spent only by a holder of the verifier, so the pair is what
// binds the redemption rather than this list.
const usableRedirect = (value: string): boolean => {
  const url = parsedUrl(value);
  return url !== null && url.protocol === "https:" && url.hash === "" && url.username === "" && url.password === "";
};

export type Registration =
  | { ok: true; clientName: string; redirectUris: string[] }
  | { ok: false; error: string; description: string };

const refuseRegistration = (error: string, description: string): Registration => ({ ok: false, error, description });

// RFC 7591 lets a client send far more than this reads, and a server that validates all of it
// refuses registrations that would have worked: the metadata a client sends describes what it can
// do, and everything here either matches what the endpoint does or is ignored. `redirect_uris` is
// the one member that has to be right, because it is the only one that decides where a code goes.
export const readRegistration = (body: unknown): Registration => {
  if (!isRecord(body))
    return refuseRegistration("invalid_client_metadata", "the registration body is not a JSON object");
  const { redirect_uris: uris, client_name: name } = body;
  if (!Array.isArray(uris) || uris.length === 0) {
    return refuseRegistration("invalid_redirect_uri", "redirect_uris must hold at least one address");
  }
  if (uris.length > REDIRECT_URI_LIMIT) {
    return refuseRegistration("invalid_redirect_uri", `redirect_uris holds at most ${REDIRECT_URI_LIMIT} addresses`);
  }
  const redirectUris = uris.filter((uri): uri is string => typeof uri === "string");
  if (redirectUris.length !== uris.length || !redirectUris.every(usableRedirect)) {
    return refuseRegistration(
      "invalid_redirect_uri",
      "every redirect_uri must be an https address carrying no fragment and no userinfo",
    );
  }
  const clientName =
    typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, CLIENT_NAME_LIMIT) : "an MCP client";
  return { ok: true, clientName, redirectUris };
};

export const registrationResponse = (client: OauthClient, now: number): unknown => ({
  client_id: client.clientId,
  client_id_issued_at: Math.floor(now / 1000),
  client_name: client.clientName,
  redirect_uris: client.redirectUris,
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  scope: SCOPE,
});

export const registerClient = async (
  db: AccountDb,
  clientName: string,
  redirectUris: string[],
  now: number,
): Promise<OauthClient> => {
  const clientId = randomToken();
  await db
    .insert(oauthClients)
    .values({ clientId, clientName, redirectUris: JSON.stringify(redirectUris), createdAt: now })
    .run();
  return { clientId, clientName, redirectUris };
};

const toClient = (row: { clientId: string; clientName: string; redirectUris: string }): OauthClient | null => {
  const parsed: unknown = JSON.parse(row.redirectUris);
  if (!Array.isArray(parsed)) return null;
  const redirectUris = parsed.filter((uri): uri is string => typeof uri === "string");
  return { clientId: row.clientId, clientName: row.clientName, redirectUris };
};

export const clientFor = async (db: AccountDb, clientId: string): Promise<OauthClient | null> => {
  const row = await db
    .select({
      clientId: oauthClients.clientId,
      clientName: oauthClients.clientName,
      redirectUris: oauthClients.redirectUris,
    })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .get();
  return row === undefined ? null : toClient(row);
};

export interface AuthorizeAsk {
  responseType: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resources: string[];
}

// What the authorize address carries, as the query wrote it. Every member is read as a string and
// judged below, because a client that sends a parameter twice is a client whose first value must
// never be the one acted on.
export const readAuthorizeAsk = (url: URL): AuthorizeAsk => {
  const one = (name: string): string => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 ? (values[0] ?? "") : "";
  };
  return {
    responseType: one("response_type"),
    clientId: one("client_id"),
    redirectUri: one("redirect_uri"),
    state: one("state"),
    codeChallenge: one("code_challenge"),
    codeChallengeMethod: one("code_challenge_method"),
    resources: url.searchParams.getAll("resource"),
  };
};

// RFC 8707 is optional on both endpoints here: claude.ai sends no `resource` at all, and refusing
// it for that is what Cloudflare's own managed OAuth does and why it cannot serve that client. A
// value that is sent is still held to naming this endpoint, so a token minted for some other
// audience is never one of ours.
export const resourceMismatch = (resources: string[], origin: string): boolean =>
  resources.some((resource) => resource !== resourceOf(origin) && resource !== origin);

export const redirectFor = (ask: AuthorizeAsk, client: OauthClient): string | null => {
  if (ask.redirectUri === "") return client.redirectUris.length === 1 ? (client.redirectUris[0] ?? null) : null;
  return client.redirectUris.includes(ask.redirectUri) ? ask.redirectUri : null;
};

export type AskRefusal = { error: string; description: string };

export const askRefusal = (ask: AuthorizeAsk, origin: string): AskRefusal | null => {
  if (ask.responseType !== "code") {
    return { error: "unsupported_response_type", description: "response_type must be code" };
  }
  if (ask.codeChallengeMethod !== "S256") {
    return { error: "invalid_request", description: "code_challenge_method must be S256" };
  }
  if (!CHALLENGE_PATTERN.test(ask.codeChallenge)) {
    return { error: "invalid_request", description: "code_challenge must be a base64url SHA-256 digest" };
  }
  if (resourceMismatch(ask.resources, origin)) {
    return { error: "invalid_target", description: `resource must be ${resourceOf(origin)}` };
  }
  return null;
};

// Where the browser is sent once the ask has been judged, whether that is a code, a refusal or the
// user's own denial. `iss` goes on every answer because the metadata says it does, and a client
// that checks it must find it on the error as readily as on the code.
export const redirectBack = (
  redirectUri: string,
  state: string,
  origin: string,
  answer: Record<string, string>,
): string => {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(answer)) url.searchParams.set(name, value);
  if (state !== "") url.searchParams.set("state", state);
  url.searchParams.set("iss", origin);
  return url.toString();
};

export const startAuthorization = async (
  db: AccountDb,
  ask: AuthorizeAsk,
  redirectUri: string,
  now: number,
): Promise<string> => {
  const requestId = randomToken();
  await db.batch([
    db.delete(oauthRequests).where(lte(oauthRequests.expiresAt, now)),
    db.insert(oauthRequests).values({
      requestId,
      clientId: ask.clientId,
      redirectUri,
      state: ask.state,
      codeChallenge: ask.codeChallenge,
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
    }),
  ]);
  return requestId;
};

export const pendingAuthorization = async (
  db: AccountDb,
  requestId: string,
  now: number,
): Promise<AuthorizationRequest | null> => {
  const row = await db
    .select({
      requestId: oauthRequests.requestId,
      clientId: oauthRequests.clientId,
      clientName: oauthClients.clientName,
      redirectUri: oauthRequests.redirectUri,
      state: oauthRequests.state,
      codeChallenge: oauthRequests.codeChallenge,
      expiresAt: oauthRequests.expiresAt,
    })
    .from(oauthRequests)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthRequests.clientId))
    .where(eq(oauthRequests.requestId, requestId))
    .get();
  if (row === undefined || row.expiresAt <= now) return null;
  return {
    requestId: row.requestId,
    clientId: row.clientId,
    clientName: row.clientName,
    redirectUri: row.redirectUri,
    state: row.state,
    codeChallenge: row.codeChallenge,
  };
};

export const forgetAuthorization = async (db: AccountDb, requestId: string): Promise<void> => {
  await db.delete(oauthRequests).where(eq(oauthRequests.requestId, requestId)).run();
};

// The code is minted out of the request row rather than out of anything the browser posted back,
// so the client, the callback and the challenge it is bound to are the ones the authorize address
// carried; the account is the one the Access assertion named a moment ago.
export const grantCode = async (
  db: AccountDb,
  request: AuthorizationRequest,
  userId: string,
  now: number,
): Promise<string> => {
  const code = randomToken();
  await db.batch([
    db.delete(oauthCodes).where(lte(oauthCodes.expiresAt, now)),
    db.insert(oauthCodes).values({
      codeSha256: await sha256Hex(code),
      clientId: request.clientId,
      userId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
    }),
    db.delete(oauthRequests).where(eq(oauthRequests.requestId, request.requestId)),
  ]);
  return code;
};

const pkceMatches = async (verifier: string, challenge: string): Promise<boolean> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return sameSecret(base64Url(digest), challenge);
};

const issue = async (db: AccountDb, clientId: string, userId: string, now: number): Promise<Issued> => {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  await db.batch([
    db.delete(oauthTokens).where(lte(oauthTokens.expiresAt, now)),
    db.insert(oauthTokens).values({
      tokenSha256: await sha256Hex(accessToken),
      clientId,
      userId,
      kind: "access",
      createdAt: now,
      expiresAt: now + ACCESS_TTL_MS,
    }),
    db.insert(oauthTokens).values({
      tokenSha256: await sha256Hex(refreshToken),
      clientId,
      userId,
      kind: "refresh",
      createdAt: now,
      expiresAt: now + REFRESH_TTL_MS,
    }),
  ]);
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_MS / 1000 };
};

const refuseGrant = (error: string, description: string): TokenOutcome => ({ ok: false, error, description });

export interface CodeRedemption {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  resources: string[];
}

// A code is spent once: the row is deleted in the same statement that reads it, so two redemptions
// racing cannot both find it and the second is told the code is unknown. Every other check reads
// the row that delete returned, which is the state the code was minted in and not one a later
// request could have moved.
export const redeemCode = async (
  db: AccountDb,
  redemption: CodeRedemption,
  origin: string,
  now: number,
): Promise<TokenOutcome> => {
  if (!VERIFIER_PATTERN.test(redemption.codeVerifier)) {
    return refuseGrant("invalid_request", "code_verifier must hold 43 to 128 unreserved characters");
  }
  if (resourceMismatch(redemption.resources, origin)) {
    return refuseGrant("invalid_target", `resource must be ${resourceOf(origin)}`);
  }
  const spent = await db
    .delete(oauthCodes)
    .where(eq(oauthCodes.codeSha256, await sha256Hex(redemption.code)))
    .returning({
      clientId: oauthCodes.clientId,
      userId: oauthCodes.userId,
      redirectUri: oauthCodes.redirectUri,
      codeChallenge: oauthCodes.codeChallenge,
      expiresAt: oauthCodes.expiresAt,
    })
    .get();
  if (spent === undefined) return refuseGrant("invalid_grant", "the authorization code is unknown or already used");
  if (spent.expiresAt <= now) return refuseGrant("invalid_grant", "the authorization code expired");
  if (spent.clientId !== redemption.clientId) {
    return refuseGrant("invalid_grant", "the authorization code was issued to another client");
  }
  if (redemption.redirectUri !== "" && redemption.redirectUri !== spent.redirectUri) {
    return refuseGrant("invalid_grant", "redirect_uri does not match the one the authorization carried");
  }
  if (!(await pkceMatches(redemption.codeVerifier, spent.codeChallenge))) {
    return refuseGrant("invalid_grant", "code_verifier does not match the code_challenge");
  }
  return { ok: true, issued: await issue(db, spent.clientId, spent.userId, now) };
};

// A refresh is a rotation: the token presented is deleted as it is read and a new pair takes its
// place, so a refresh token that reaches a second holder is spent by whoever gets there first and
// the other is told it is unknown.
export const refreshGrant = async (
  db: AccountDb,
  refreshToken: string,
  clientId: string,
  origin: string,
  resources: string[],
  now: number,
): Promise<TokenOutcome> => {
  if (resourceMismatch(resources, origin)) {
    return refuseGrant("invalid_target", `resource must be ${resourceOf(origin)}`);
  }
  const spent = await db
    .delete(oauthTokens)
    .where(and(eq(oauthTokens.tokenSha256, await sha256Hex(refreshToken)), eq(oauthTokens.kind, "refresh")))
    .returning({ clientId: oauthTokens.clientId, userId: oauthTokens.userId, expiresAt: oauthTokens.expiresAt })
    .get();
  if (spent === undefined) return refuseGrant("invalid_grant", "the refresh token is unknown or already used");
  if (spent.expiresAt <= now) return refuseGrant("invalid_grant", "the refresh token expired");
  if (spent.clientId !== clientId) return refuseGrant("invalid_grant", "the refresh token belongs to another client");
  return { ok: true, issued: await issue(db, spent.clientId, spent.userId, now) };
};

export const tokenResponse = (issued: Issued): unknown => ({
  access_token: issued.accessToken,
  token_type: "Bearer",
  expires_in: issued.expiresIn,
  refresh_token: issued.refreshToken,
  scope: SCOPE,
});

export const userForAccessToken = async (db: AccountDb, token: string, now: number): Promise<string | null> => {
  const row = await db
    .select({ userId: oauthTokens.userId, expiresAt: oauthTokens.expiresAt })
    .from(oauthTokens)
    .where(and(eq(oauthTokens.tokenSha256, await sha256Hex(token)), eq(oauthTokens.kind, "access")))
    .get();
  if (row === undefined || row.expiresAt <= now) return null;
  return row.userId;
};
