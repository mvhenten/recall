import { describe, expect, it } from "vitest";
import { MCP_PATH } from "../src/mcp";
import { CONNECT_CSRF_COOKIE } from "../src/page";
import { harness, MCP_AUDIENCE } from "./harness";

const ORIGIN = "https://recall.test";
const RESOURCE = `${ORIGIN}${MCP_PATH}`;
const RESOURCE_METADATA = `${ORIGIN}/.well-known/oauth-protected-resource${MCP_PATH}`;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(43);

type Harness = Awaited<ReturnType<typeof harness>>;

const challengeOf = async (verifier: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const body = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const register = (h: Harness, fields: Record<string, unknown> = {}): Promise<Response> =>
  h.send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: "Claude", ...fields }),
  });

const registeredClient = async (h: Harness, fields: Record<string, unknown> = {}): Promise<string> => {
  const response = await register(h, fields);
  if (response.status !== 201) throw new Error(`register: ${response.status} ${await response.text()}`);
  return (await body<{ client_id: string }>(response)).client_id;
};

// A parameter set to undefined is one the client did not send, which is not the same as one it
// sent empty: the query carries neither the name nor a value for it.
const authorize = (h: Harness, params: Record<string, string | undefined>): Promise<Response> => {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined) query.set(name, value);
  return h.send(`/oauth/authorize?${query.toString()}`);
};

const ask = async (
  h: Harness,
  clientId: string,
  overrides: Record<string, string | undefined> = {},
): Promise<Response> =>
  authorize(h, {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "opaque-state",
    code_challenge: await challengeOf(VERIFIER),
    code_challenge_method: "S256",
    ...overrides,
  });

const requestIdOf = (response: Response): string => {
  const location = response.headers.get("location") ?? "";
  const id = new URL(location, ORIGIN).searchParams.get("request");
  if (id === null) throw new Error(`authorize sent the browser to ${location}`);
  return id;
};

// The sign-in step, as Access leaves it: the browser arrives at the consent path carrying an
// assertion of the connector's own application, reads the page, and posts the form back.
const consent = async (
  h: Harness,
  requestId: string,
  assertion: string,
  action: "approve" | "deny" = "approve",
): Promise<Response> => {
  const drawn = await h.send(`/oauth/consent?request=${requestId}`, {
    headers: { "cf-access-jwt-assertion": assertion },
  });
  if (drawn.status !== 200) throw new Error(`consent: ${drawn.status} ${await drawn.text()}`);
  const csrf = await h.csrfOf(drawn);
  return h.send("/oauth/consent", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": assertion,
      origin: ORIGIN,
      cookie: `${CONNECT_CSRF_COOKIE}=${csrf}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ request: requestId, action, csrf }),
  });
};

const codeOf = (response: Response): string => {
  const location = response.headers.get("location") ?? "";
  const code = new URL(location).searchParams.get("code");
  if (code === null) throw new Error(`consent sent the browser to ${location}`);
  return code;
};

const redeem = (h: Harness, fields: Record<string, string>): Promise<Response> =>
  h.send("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

const toolsList = (h: Harness, headers: Record<string, string>): Promise<Response> =>
  h.rpc({ id: 1, method: "tools/list" }, headers);

describe("what a web MCP client discovers", () => {
  it("answers an unauthenticated call with the one header the connect flow starts from", async () => {
    const h = await harness();
    const refused = await toolsList(h, {});
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}"`);

    // A client that takes only a stream reads the same refusal off the stream, header and all.
    const streamed = await h.send(MCP_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(streamed.status).toBe(401);
    expect(streamed.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}"`);
  });

  it("serves the protected resource document at the path-based address and at the root", async () => {
    const h = await harness();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const served = await h.send(path);
      expect(served.status).toBe(200);
      const document = await body<{ resource: string; authorization_servers: string[]; scopes_supported: string[] }>(
        served,
      );
      // claude.ai compares this to the URL the user typed, so it is the endpoint's address exactly.
      expect(document.resource).toBe(RESOURCE);
      expect(document.authorization_servers[0]).toBe(ORIGIN);
      expect(document.scopes_supported).toEqual(["recall"]);
    }
  });

  it("serves the authorization server document naming a public client with PKCE", async () => {
    const h = await harness();
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
      const served = await h.send(path);
      expect(served.status).toBe(200);
      expect(await body(served)).toMatchObject({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        token_endpoint: `${ORIGIN}/oauth/token`,
        registration_endpoint: `${ORIGIN}/oauth/register`,
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    }
  });

  it("discovers nothing where the deployment serves no connector", async () => {
    const h = await harness({ mcpConnector: "off" });
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/oauth/authorize",
      "/oauth/consent",
    ]) {
      expect((await h.send(path)).status).toBe(404);
    }
    expect((await h.send("/oauth/register", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("lets the browser clients call the endpoint and the documents from a page", async () => {
    const h = await harness();
    const preflight = await h.send(MCP_PATH, { method: "OPTIONS", headers: { origin: "https://chat.mistral.ai" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://chat.mistral.ai");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

    const refused = await toolsList(h, { origin: "https://claude.ai" });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(refused.headers.get("access-control-expose-headers")).toContain("www-authenticate");

    const document = await h.send("/.well-known/oauth-protected-resource/mcp", {
      headers: { origin: "https://chat.mistral.ai" },
    });
    expect(document.headers.get("access-control-allow-origin")).toBe("*");

    // Every other origin is still refused outright, which is what keeps a page on a fourth host
    // from driving the connector with an Access cookie the reader already holds.
    const elsewhere = await toolsList(h, { origin: "https://evil.example" });
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.headers.get("access-control-allow-origin")).toBe(null);
  });
});

describe("registering a client", () => {
  it("takes the callbacks the hosted clients use and ignores the metadata it does not act on", async () => {
    const h = await harness();
    const registered = await register(h, {
      redirect_uris: [
        "https://claude.ai/api/mcp/auth_callback",
        "https://chatgpt.com/connector_platform_oauth_redirect",
        "https://chatgpt.com/connector/oauth/4f9c",
        "https://callback.mistral.ai/v1/integrations_auth/oauth2_callback",
      ],
      grant_types: ["authorization_code", "refresh_token", "implicit"],
      application_type: "web",
      software_id: "le-chat",
      contacts: ["nobody@example.com"],
      jwks_uri: "https://chat.mistral.ai/jwks.json",
      unheard_of_member: { nested: true },
    });
    expect(registered.status).toBe(201);
    const client = await body<{ client_id: string; redirect_uris: string[]; token_endpoint_auth_method: string }>(
      registered,
    );
    expect(client.client_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(client.redirect_uris).toHaveLength(4);
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(registered.headers.get("cache-control")).toBe("no-store");
  });

  it("names a client that sent no name and refuses a callback it would not send a code to", async () => {
    const h = await harness();
    const unnamed = await register(h, { client_name: undefined });
    expect((await body<{ client_name: string }>(unnamed)).client_name).toBe("an MCP client");

    for (const uris of [
      [],
      ["http://claude.ai/api/mcp/auth_callback"],
      ["https://claude.ai/api/mcp/auth_callback#fragment"],
      ["https://user:secret@claude.ai/api/mcp/auth_callback"],
      ["not-a-url"],
      [7],
    ]) {
      const refused = await register(h, { redirect_uris: uris });
      expect(refused.status).toBe(400);
      expect((await body<{ error: string }>(refused)).error).toBe("invalid_redirect_uri");
    }
    expect((await register(h, { redirect_uris: undefined })).status).toBe(400);
  });
});

describe("the authorize, consent, code and token chain", () => {
  it("carries a client through to a bearer token that reaches the tools", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const clientId = await registeredClient(h);
    const granted = await consent(h, requestIdOf(await ask(h, clientId)), await h.assertionFor(email, MCP_AUDIENCE));
    const answered = await redeem(h, {
      grant_type: "authorization_code",
      code: codeOf(granted),
      code_verifier: VERIFIER,
      client_id: clientId,
      redirect_uri: CALLBACK,
    });
    expect(answered.status).toBe(200);
    const tokens = await body<Tokens>(answered);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe("recall");

    const listed = await toolsList(h, { authorization: `Bearer ${tokens.access_token}` });
    expect(listed.status).toBe(200);
    expect((await body<{ result: { tools: unknown[] } }>(listed)).result.tools.length).toBeGreaterThan(0);

    // The bearer lane registers the connector row every connector takes, so a tool call lands in
    // the account the consent named.
    const saved = await h.rpc(
      {
        id: 2,
        method: "tools/call",
        params: {
          name: "recall_save",
          arguments: { name: "indent-style", description: "how to indent", type: "feedback", body: "Two spaces." },
        },
      },
      { authorization: `Bearer ${tokens.access_token}` },
    );
    const result = await body<{ result: { content: Array<{ text: string }>; isError?: boolean } }>(saved);
    expect(result.result.isError).toBe(undefined);
    expect(JSON.parse(result.result.content[0]?.text ?? "{}")).toMatchObject({ name: "indent-style", created: true });
  });

  it("sends the browser to the consent path and the code back with the state and the issuer", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const clientId = await registeredClient(h);
    const started = await ask(h, clientId);
    expect(started.status).toBe(303);
    expect(new URL(started.headers.get("location") ?? "", ORIGIN).pathname).toBe("/oauth/consent");

    const granted = await consent(h, requestIdOf(started), await h.assertionFor(email, MCP_AUDIENCE));
    expect(granted.status).toBe(303);
    const back = new URL(granted.headers.get("location") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("opaque-state");
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
    expect(back.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("asks the user and sends back a denial when the answer is no", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const clientId = await registeredClient(h);
    const started = await ask(h, clientId);
    const denied = await consent(h, requestIdOf(started), await h.assertionFor(email, MCP_AUDIENCE), "deny");
    const back = new URL(denied.headers.get("location") ?? "");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBe(null);
    expect(back.searchParams.get("state")).toBe("opaque-state");
  });

  it("refuses a consent nobody signed in for and one the form did not come from", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const assertion = await h.assertionFor(email, MCP_AUDIENCE);
    const clientId = await registeredClient(h);
    const requestId = requestIdOf(await ask(h, clientId));

    expect((await h.send(`/oauth/consent?request=${requestId}`)).status).toBe(401);
    const drawn = await h.send(`/oauth/consent?request=${requestId}`, {
      headers: { "cf-access-jwt-assertion": assertion },
    });
    const csrf = await h.csrfOf(drawn);
    const post = (origin: string, cookie: string, formCsrf: string): Promise<Response> =>
      h.send("/oauth/consent", {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": assertion,
          origin,
          cookie: `${CONNECT_CSRF_COOKIE}=${cookie}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ request: requestId, action: "approve", csrf: formCsrf }),
      });
    expect((await post("https://evil.example", csrf, csrf)).status).toBe(403);
    expect((await post(ORIGIN, csrf, "forged")).status).toBe(403);
    expect((await post(ORIGIN, csrf, csrf)).status).toBe(303);
  });

  it("refuses an email the deployment never invited and an assertion naming a machine", async () => {
    const h = await harness();
    const clientId = await registeredClient(h);
    const stranger = await h.assertionFor(`stranger-${crypto.randomUUID()}@example.com`, MCP_AUDIENCE);
    const uninvited = await h.send(`/oauth/consent?request=${requestIdOf(await ask(h, clientId))}`, {
      headers: { "cf-access-jwt-assertion": stranger },
    });
    expect(uninvited.status).toBe(403);

    const machine = await h.send(`/oauth/consent?request=${requestIdOf(await ask(h, clientId))}`, {
      headers: { "cf-access-jwt-assertion": await h.serviceAssertionFor("recall-alice-connector", MCP_AUDIENCE) },
    });
    expect(machine.status).toBe(401);
  });

  it("refuses an unknown client and a callback the client never registered", async () => {
    const h = await harness();
    const clientId = await registeredClient(h);
    expect((await ask(h, "nobody")).status).toBe(400);
    const wrong = await ask(h, clientId, { redirect_uri: "https://evil.example/callback" });
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get("location")).toBe(null);
  });

  it("sends a refusal the client can act on back to the callback", async () => {
    const h = await harness();
    const clientId = await registeredClient(h);
    const errorOf = async (overrides: Record<string, string>): Promise<string | null> => {
      const refused = await ask(h, clientId, overrides);
      expect(refused.status).toBe(303);
      return new URL(refused.headers.get("location") ?? "").searchParams.get("error");
    };
    expect(await errorOf({ response_type: "token" })).toBe("unsupported_response_type");
    expect(await errorOf({ code_challenge_method: "plain" })).toBe("invalid_request");
    expect(await errorOf({ code_challenge: "too-short" })).toBe("invalid_request");
    expect(await errorOf({ resource: "https://elsewhere.example/mcp" })).toBe("invalid_target");
  });

  // RFC 8707 is optional on both endpoints: claude.ai sends no `resource` at all, which is why
  // Cloudflare's own managed OAuth cannot serve it.
  it("takes the resource parameter where a client sends it and never requires it", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const clientId = await registeredClient(h);
    const started = await ask(h, clientId, { resource: RESOURCE });
    const granted = await consent(h, requestIdOf(started), await h.assertionFor(email, MCP_AUDIENCE));
    const named = await redeem(h, {
      grant_type: "authorization_code",
      code: codeOf(granted),
      code_verifier: VERIFIER,
      client_id: clientId,
      redirect_uri: CALLBACK,
      resource: RESOURCE,
    });
    expect(named.status).toBe(200);

    const second = await consent(h, requestIdOf(await ask(h, clientId)), await h.assertionFor(email, MCP_AUDIENCE));
    const elsewhere = await redeem(h, {
      grant_type: "authorization_code",
      code: codeOf(second),
      code_verifier: VERIFIER,
      client_id: clientId,
      redirect_uri: CALLBACK,
      resource: "https://elsewhere.example/mcp",
    });
    expect((await body<{ error: string }>(elsewhere)).error).toBe("invalid_target");
  });
});

describe("what an uncredentialed write may leave behind", () => {
  it("caps the state it will hold for a client", async () => {
    const h = await harness();
    const clientId = await registeredClient(h);
    const refused = await ask(h, clientId, { state: "s".repeat(513) });
    expect(refused.status).toBe(303);
    expect(new URL(refused.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_request");
    expect((await ask(h, clientId, { state: "s".repeat(512) })).status).toBe(303);
  });

  // Not sent and sent empty are different answers, which is why the row says which it was rather
  // than reading the empty string as an absence.
  it("echoes the state a client sent, including none at all and the empty one", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const assertion = await h.assertionFor(email, MCP_AUDIENCE);
    const clientId = await registeredClient(h);

    const silent = await consent(h, requestIdOf(await ask(h, clientId, { state: undefined })), assertion);
    expect(new URL(silent.headers.get("location") ?? "").searchParams.has("state")).toBe(false);

    const empty = await consent(h, requestIdOf(await ask(h, clientId, { state: "" })), assertion);
    expect(new URL(empty.headers.get("location") ?? "").searchParams.get("state")).toBe("");
  });

  it("sweeps a registration no client ever carried through a sign-in", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const abandoned = await registeredClient(h);
    const connected = await h.connect(email);
    // The abandoned client got as far as an authorize address and no further, which leaves the
    // request row that would pin it if liveness were read off a row existing instead of expiring.
    expect((await ask(h, abandoned)).status).toBe(303);

    // The sweep rides the next registration, which is the only thing that reads this table.
    h.tick(3_600_001);
    await registeredClient(h);

    expect((await ask(h, abandoned)).status).toBe(400);
    // The one that reached a sign-in holds a refresh token, and its row stands as long as that does.
    expect((await ask(h, connected.clientId)).status).toBe(303);
  });
});

describe("what the token endpoint refuses", () => {
  const spend = async (h: Harness, email: string): Promise<{ clientId: string; code: string }> => {
    const clientId = await registeredClient(h);
    const granted = await consent(h, requestIdOf(await ask(h, clientId)), await h.assertionFor(email, MCP_AUDIENCE));
    return { clientId, code: codeOf(granted) };
  };

  it("refuses a verifier that does not answer the challenge", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const { clientId, code } = await spend(h, email);
    const refused = await redeem(h, {
      grant_type: "authorization_code",
      code,
      code_verifier: "b".repeat(43),
      client_id: clientId,
      redirect_uri: CALLBACK,
    });
    expect(refused.status).toBe(400);
    expect(await body(refused)).toMatchObject({ error: "invalid_grant" });

    // The code was spent by the attempt, so the holder of the right verifier gets nothing either.
    const late = await redeem(h, {
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      client_id: clientId,
      redirect_uri: CALLBACK,
    });
    expect(await body(late)).toMatchObject({ error: "invalid_grant" });
  });

  it("spends a code once and lets it expire", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const first = await spend(h, email);
    const spent = {
      grant_type: "authorization_code",
      code: first.code,
      code_verifier: VERIFIER,
      client_id: first.clientId,
      redirect_uri: CALLBACK,
    };
    expect((await redeem(h, spent)).status).toBe(200);
    expect((await redeem(h, spent)).status).toBe(400);

    const second = await spend(h, email);
    h.tick(120_001);
    const stale = await redeem(h, {
      grant_type: "authorization_code",
      code: second.code,
      code_verifier: VERIFIER,
      client_id: second.clientId,
      redirect_uri: CALLBACK,
    });
    expect(await body(stale)).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a code redeemed by another client, a wrong callback and a malformed verifier", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const other = await registeredClient(h);

    const borrowed = await spend(h, email);
    expect(
      await body(
        await redeem(h, {
          grant_type: "authorization_code",
          code: borrowed.code,
          code_verifier: VERIFIER,
          client_id: other,
          redirect_uri: CALLBACK,
        }),
      ),
    ).toMatchObject({ error: "invalid_grant" });

    const mismatched = await spend(h, email);
    expect(
      await body(
        await redeem(h, {
          grant_type: "authorization_code",
          code: mismatched.code,
          code_verifier: VERIFIER,
          client_id: mismatched.clientId,
          redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
        }),
      ),
    ).toMatchObject({ error: "invalid_grant" });

    const short = await spend(h, email);
    expect(
      await body(
        await redeem(h, {
          grant_type: "authorization_code",
          code: short.code,
          code_verifier: "too-short",
          client_id: short.clientId,
          redirect_uri: CALLBACK,
        }),
      ),
    ).toMatchObject({ error: "invalid_request" });

    // The authorize step resolved a callback whether the client named one or not, so the
    // comparison always has something to compare and a redemption that leaves it out is refused.
    const silent = await spend(h, email);
    expect(
      await body(
        await redeem(h, {
          grant_type: "authorization_code",
          code: silent.code,
          code_verifier: VERIFIER,
          client_id: silent.clientId,
        }),
      ),
    ).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a grant type it does not serve", async () => {
    const h = await harness();
    const refused = await redeem(h, { grant_type: "client_credentials" });
    expect(await body(refused)).toMatchObject({ error: "unsupported_grant_type" });
    expect((await h.send("/oauth/token")).status).toBe(405);
  });
});

describe("the token a client holds afterwards", () => {
  it("stops working when it expires and keeps the refresh token going", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const { clientId, accessToken, refreshToken } = await h.connect(email);
    expect((await toolsList(h, { authorization: `Bearer ${accessToken}` })).status).toBe(200);

    h.tick(3_600_001);
    const stale = await toolsList(h, { authorization: `Bearer ${accessToken}` });
    expect(stale.status).toBe(401);
    expect(stale.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(stale.headers.get("www-authenticate")).toContain(RESOURCE_METADATA);

    const refreshed = await redeem(h, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const second = await body<Tokens>(refreshed);
    expect(second.access_token).not.toBe(accessToken);
    expect((await toolsList(h, { authorization: `Bearer ${second.access_token}` })).status).toBe(200);

    // The refresh is a rotation, so the token just spent is no longer one.
    const replayed = await redeem(h, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    expect(await body(replayed)).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a refresh token another client presents and one that expired", async () => {
    const h = await harness();
    const email = await h.invite(`owner-${crypto.randomUUID()}@example.com`);
    const borrowed = await h.connect(email);
    const other = await registeredClient(h);
    expect(
      await body(
        await redeem(h, { grant_type: "refresh_token", refresh_token: borrowed.refreshToken, client_id: other }),
      ),
    ).toMatchObject({ error: "invalid_grant" });

    const fresh = await h.connect(email);
    h.tick(2_592_000_001);
    expect(
      await body(
        await redeem(h, { grant_type: "refresh_token", refresh_token: fresh.refreshToken, client_id: fresh.clientId }),
      ),
    ).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a bearer token it never issued", async () => {
    const h = await harness();
    const unknown = await toolsList(h, { authorization: `Bearer ${"z".repeat(43)}` });
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("www-authenticate")).toContain(RESOURCE_METADATA);
  });
});
