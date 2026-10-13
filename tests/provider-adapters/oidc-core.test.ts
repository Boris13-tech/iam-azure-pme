import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as client from "openid-client";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SecretLease, type SecretResolver } from "../../lib/provider-adapters";
import { OpenIdClientOidcGateway, type OidcClientConfig, type OidcProfile } from "../../lib/provider-adapters/implementations/oidc";
import { MICROSOFT_ENTRA_OIDC_PROFILE, microsoftEntraClaims, microsoftEntraIssuer } from "../../lib/provider-adapters/implementations/microsoft-entra/oidc-client";

// The generic OIDC core (sovereign design, F1) against a real, local OpenID provider: discovery, JWKS, the token
// endpoint with PKCE and client authentication, and signed ID tokens. Every check that must fail closed (rule R8) has
// its own case. The provider runs over plain HTTP on 127.0.0.1, so only this test passes allowInsecureRequests.
const CLIENT_ID = "luxia-test-client";
const CLIENT_SECRET = "test-client-secret-never-logged";
const PROFILE: OidcProfile = { displayName: "Test IdP", subjectClaim: "sub" };
const context = { organizationId: "org-1", tenantId: "tenant-1", providerConnectionId: "conn-1", operationId: "op-1" };

type Behaviour = {
  iss?: string; aud?: string; sub?: string | null; nonce?: string; alg?: "RS256" | "HS256" | "none";
  otherKey?: boolean; expired?: boolean; metadataIssuer?: string;
};
let behaviour: Behaviour = {};
let issuer = "";
let server: Server;
let privateKey: CryptoKey; let otherKey: CryptoKey; let publicJwk: JWK;
const pending = new Map<string, { challenge: string; nonce: string }>();

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

async function idToken(nonce: string): Promise<string> {
  const claims: Record<string, unknown> = { nonce: behaviour.nonce ?? nonce, email: "person@example.test", name: "Test Person" };
  if (behaviour.sub !== null) claims.sub = behaviour.sub ?? "subject-123";
  const now = Math.floor(Date.now() / 1000);
  const iat = behaviour.expired ? now - 3600 : now;
  const exp = behaviour.expired ? now - 1800 : now + 300;
  if (behaviour.alg === "none") {
    const payload = { ...claims, iss: behaviour.iss ?? issuer, aud: behaviour.aud ?? CLIENT_ID, iat, exp };
    return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.`;
  }
  const jwt = new SignJWT(claims).setIssuer(behaviour.iss ?? issuer).setAudience(behaviour.aud ?? CLIENT_ID).setIssuedAt(iat).setExpirationTime(exp);
  if (behaviour.alg === "HS256") return jwt.setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(CLIENT_SECRET));
  return jwt.setProtectedHeader({ alg: "RS256", kid: "key-1" }).sign(behaviour.otherKey ? otherKey : privateKey);
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise(resolve => { let data = ""; request.on("data", chunk => { data += chunk; }); request.on("end", () => resolve(data)); });
}

beforeAll(async () => {
  ({ privateKey: otherKey } = await generateKeyPair("RS256"));
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    const json = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (url.pathname === "/.well-known/openid-configuration") return json(200, {
      issuer: behaviour.metadataIssuer ?? issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/logout`, response_types_supported: ["code"],
      subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    });
    if (url.pathname === "/jwks") return json(200, { keys: [publicJwk] });
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await readBody(request));
      const basic = request.headers.authorization?.startsWith("Basic ")
        ? Buffer.from(request.headers.authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent) : null;
      const [id, secret] = basic ?? [form.get("client_id"), form.get("client_secret")];
      if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return json(401, { error: "invalid_client" });
      const grant = pending.get(form.get("code") ?? "");
      if (!grant) return json(400, { error: "invalid_grant" });
      pending.delete(form.get("code")!);
      if (b64url(createHash("sha256").update(form.get("code_verifier") ?? "").digest()) !== grant.challenge) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: "access-token", token_type: "Bearer", expires_in: 300, id_token: await idToken(grant.nonce) });
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => { behaviour = {}; });

const secrets: SecretResolver = {
  async withSecret(_context, reference, consumer) {
    const lease = new SecretLease(new TextEncoder().encode(reference.key === "client-secret" ? CLIENT_SECRET : "wrong"));
    try { return await consumer(lease); } finally { lease.dispose(); }
  },
};
const gateway = () => new OpenIdClientOidcGateway(secrets, { execute: [client.allowInsecureRequests] });
const config = (overrides: Partial<OidcClientConfig> = {}): OidcClientConfig =>
  ({ issuer, clientId: CLIENT_ID, clientSecret: { key: "client-secret" }, redirectUri: "http://127.0.0.1/auth/callback", ...overrides });

/** The whole round trip: begin, the provider issues a code, the browser comes back, complete. */
async function signIn(options: { state?: string; config?: OidcClientConfig } = {}) {
  const used = options.config ?? config();
  const begun = await gateway().begin(context, PROFILE, used);
  const authorization = new URL(begun.authorizationUrl);
  const code = randomUUID();
  pending.set(code, { challenge: authorization.searchParams.get("code_challenge") ?? "", nonce: authorization.searchParams.get("nonce") ?? "" });
  const callback = new URL(used.redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", options.state ?? begun.state);
  return gateway().complete(context, PROFILE, used, { currentUrl: callback.href, codeVerifier: begun.codeVerifier, expectedState: begun.state, expectedNonce: begun.nonce });
}

describe("Generic OIDC core (F1) against a real local OpenID provider", () => {
  it("builds a code + PKCE S256 request with fresh state and nonce", async () => {
    const begun = await gateway().begin(context, PROFILE, config());
    const url = new URL(begun.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${issuer}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID, response_type: "code", scope: "openid profile email", code_challenge_method: "S256",
      state: begun.state, nonce: begun.nonce, redirect_uri: "http://127.0.0.1/auth/callback",
    });
    const again = await gateway().begin(context, PROFILE, config());
    expect(again.state).not.toBe(begun.state);
    expect(again.nonce).not.toBe(begun.nonce);
  });

  it("verifies a genuine sign-in and returns the stable subject, the exact issuer and the claims", async () => {
    const verified = await signIn();
    expect(verified.subject).toBe("subject-123");
    expect(verified.issuer).toBe(issuer);
    expect(verified.claims).toMatchObject({ email: "person@example.test", name: "Test Person", aud: CLIENT_ID });
  });

  const refused: Array<[string, Behaviour, string?]> = [
    ["an ID token from another issuer", { iss: "http://127.0.0.1:1/evil" }],
    ["an ID token for another client (audience)", { aud: "someone-else" }],
    ["an ID token signed by a key the issuer did not publish", { otherKey: true }],
    ["an HMAC-signed ID token (alg HS256)", { alg: "HS256" }],
    ["an unsigned ID token (alg none)", { alg: "none" }],
    ["an ID token whose nonce does not match", { nonce: "replayed-nonce" }],
    ["an expired ID token", { expired: true }],
    ["an ID token without sub (openid-client requires it)", { sub: null }],
    ["a discovery document that publishes another issuer", { metadataIssuer: "http://127.0.0.1:1/other" }],
  ];
  for (const [name, setup, reason] of refused) {
    it(`fails closed on ${name}`, async () => {
      behaviour = setup;
      const outcome = signIn();
      await expect(outcome).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED", ...(reason ? { safeDetails: { reason } } : {}) });
      // No failure ever carries the client secret.
      const error = await outcome.catch(e => e);
      expect(JSON.stringify(error) + String(error?.message) + String(error?.stack)).not.toContain(CLIENT_SECRET);
    });
  }

  it("fails closed when the profile's subject claim is missing (for example Entra's oid)", async () => {
    const begun = await gateway().begin(context, { displayName: "Test IdP", subjectClaim: "oid" }, config());
    const authorization = new URL(begun.authorizationUrl);
    const code = randomUUID();
    pending.set(code, { challenge: authorization.searchParams.get("code_challenge") ?? "", nonce: authorization.searchParams.get("nonce") ?? "" });
    const callback = new URL(config().redirectUri);
    callback.searchParams.set("code", code); callback.searchParams.set("state", begun.state);
    await expect(gateway().complete(context, { displayName: "Test IdP", subjectClaim: "oid" }, config(),
      { currentUrl: callback.href, codeVerifier: begun.codeVerifier, expectedState: begun.state, expectedNonce: begun.nonce }))
      .rejects.toMatchObject({ code: "AUTHENTICATION_FAILED", safeDetails: { reason: "MISSING_OID" } });
  });

  it("fails closed when the callback carries another state (CSRF)", async () => {
    await expect(signIn({ state: "forged-state" })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("fails closed with a wrong client secret, and refuses an incomplete configuration before any network call", async () => {
    await expect(signIn({ config: config({ clientSecret: { key: "other" } }) })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(gateway().begin(context, PROFILE, config({ clientId: "" }))).rejects.toMatchObject({ code: "MISCONFIGURED" });
  });

  it("builds the provider's logout URL from its own metadata", async () => {
    const url = new URL((await gateway().logoutUrl(context, PROFILE, config(), "https://luxia.example/login")) ?? "");
    expect(url.origin + url.pathname).toBe(`${issuer}/logout`);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("https://luxia.example/login");
  });
});

describe("Microsoft Entra as a profile of the core (F1, no behaviour change)", () => {
  it("uses the tenant-specific v2.0 issuer and oid as the subject", () => {
    expect(microsoftEntraIssuer("11111111-2222-3333-4444-555555555555")).toBe("https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0");
    expect(MICROSOFT_ENTRA_OIDC_PROFILE).toEqual({ displayName: "Microsoft Entra", subjectClaim: "oid" });
  });

  it("maps verified claims to exactly the shape the Entra adapter already used", () => {
    expect(microsoftEntraClaims({
      subject: "oid-1", issuer: "https://login.microsoftonline.com/tid-1/v2.0",
      claims: { oid: "oid-1", tid: "tid-1", email: "a@b.test", preferred_username: "a@b.test", name: "A", groups: ["admins"] },
    })).toEqual({ oid: "oid-1", tid: "tid-1", iss: "https://login.microsoftonline.com/tid-1/v2.0", email: "a@b.test", preferredUsername: "a@b.test", name: "A" });
  });
});
