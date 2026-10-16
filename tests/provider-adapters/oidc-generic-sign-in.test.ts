import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenIdClientOidcGateway, type OidcClientConfig } from "../../lib/provider-adapters/implementations/oidc";
import {
  GenericOidcAuthenticationProvider, OIDC_GENERIC_PROFILE, type GenericOidcConfigResolver,
} from "../../lib/provider-adapters/implementations/oidc-generic";
import { UnconfiguredSecretStore } from "../../lib/provider-adapters/infrastructure/secret-stores/unconfigured";
import { TestIdp, guardedTestFetch, resolver, testSecretStore, type TokenBehaviour } from "../helpers/oidc-test-idp";

// F4, slice S4: generic OIDC sign-in through the F1 core, against providers simulated in memory and reached only
// through the SSRF-guarded transport. One case per check of rule R8, the iat tolerance, the configuration binding,
// mix-ups between two connections, and outages. No database: the connection's configuration is given directly.
const SECRET_A = "test-secret-a-never-logged";
const SECRET_B = "test-secret-b-never-logged";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REDIRECT = "https://luxia.example/auth/callback";
let idpA: TestIdp;
let idpB: TestIdp;
let shared: TestIdp;

beforeAll(async () => {
  idpA = await TestIdp.create("https://idp-a.luxia-test.example", { "luxia-a": SECRET_A });
  idpB = await TestIdp.create("https://idp-b.luxia-test.example", { "luxia-b": SECRET_B });
  // One issuer, two client registrations: two LUXIA connections on the same provider.
  shared = await TestIdp.create("https://idp-shared.luxia-test.example", { "luxia-a": SECRET_A, "luxia-b": SECRET_B });
});
beforeEach(() => { for (const idp of [idpA, idpB, shared]) idp.reset(); });

type Connection = { id: string; client: OidcClientConfig; configurationHash: string };
const connection = (id: string, issuer: string, clientId: string, secretKey: string, hash: string, extra: Partial<OidcClientConfig> = {}): Connection => ({
  id, configurationHash: hash,
  client: { issuer, clientId, clientSecret: { key: secretKey, version: "0".repeat(32) }, redirectUri: REDIRECT,
    scope: "openid profile email", idTokenAlgorithm: "RS256", clientAuthMethod: "client_secret_basic", ...extra },
});
const A = () => connection("conn-a", idpA.issuer, "luxia-a", "akv://luxia-test/oidc-a", HASH_A);
const B = () => connection("conn-b", idpB.issuer, "luxia-b", "akv://luxia-test/oidc-b", HASH_B);
const secrets = () => testSecretStore({ "akv://luxia-test/oidc-a": SECRET_A, "akv://luxia-test/oidc-b": SECRET_B });

/** The provider as production builds it, with the guard's DNS and transport stubbed. */
function provider(target: Connection, options: { dns?: Record<string, string[]>; store?: ReturnType<typeof secrets> | UnconfiguredSecretStore } = {}) {
  const configs: GenericOidcConfigResolver = { resolve: async () => ({ client: target.client, configurationHash: target.configurationHash }) };
  const gateway = new OpenIdClientOidcGateway(options.store ?? secrets(), undefined, guardedTestFetch([idpA, idpB, shared], options.dns));
  return new GenericOidcAuthenticationProvider(configs, gateway, resolver(options.dns));
}
const context = (target: Connection, operationId = "op") =>
  ({ organizationId: "org-1", tenantId: "tenant-1", providerConnectionId: target.id, operationId });

type Begun = Awaited<ReturnType<GenericOidcAuthenticationProvider["beginAuthentication"]>>;
async function begin(target: Connection) {
  return provider(target).beginAuthentication({ context: context(target) });
}
/** Completes a begun round trip against `target`, with the callback URL the browser brings back. */
function complete(target: Connection, begun: Begun, callback: URL, overrides: Record<string, string> = {}) {
  return provider(target).completeAuthentication({
    context: context(target), transactionId: begun.transactionId,
    response: { currentUrl: callback.href, expectedState: begun.transactionId, expectedNonce: begun.continuation!.nonce,
      codeVerifier: begun.continuation!.codeVerifier, expectedConfigurationHash: begun.continuation!.configurationHash, ...overrides },
  });
}
const callbackUrl = (params: Record<string, string>) => {
  const url = new URL(REDIRECT);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
};
/** The whole round trip: begin with `target`, the person signs in at `idp`, the browser comes back. */
async function signIn(options: { target?: Connection; idp?: TestIdp; sub?: string; behaviour?: TokenBehaviour;
  callback?: (code: string, state: string) => URL; overrides?: Record<string, string> } = {}) {
  const target = options.target ?? A();
  const idp = options.idp ?? idpA;
  idp.behaviour = {};
  const begun = await begin(target);
  idp.behaviour = options.behaviour ?? {};
  const { code, state } = idp.authorize(begun.redirectUrl!, options.sub ?? "subject-123");
  const callback = options.callback?.(code, state) ?? callbackUrl({ code, state });
  return complete(target, begun, callback, options.overrides);
}
const failure = (promise: Promise<unknown>) => promise.then(() => "ACCEPTED", (error: { code?: string; safeDetails?: Record<string, unknown> }) =>
  ({ code: error.code, ...error.safeDetails }));

describe("F4 S4: generic OIDC sign-in through the F1 core", () => {
  it("happy path: a code + PKCE S256 request bound to its configuration, then the verified sub, and the issuer only", async () => {
    const begun = await begin(A());
    const url = new URL(begun.redirectUrl!);
    expect(url.origin + url.pathname).toBe(`${idpA.issuer}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "luxia-a", response_type: "code", code_challenge_method: "S256",
      scope: "openid profile email", redirect_uri: REDIRECT, state: begun.transactionId, nonce: begun.continuation!.nonce });
    expect(begun.continuation!.configurationHash).toBe(HASH_A);
    idpA.reset();
    const verified = await signIn({ behaviour: { extraClaims: { email: "person@example.test", name: "Person" } } });
    expect(verified.identity).toEqual({ externalObjectId: "subject-123" });
    // R6 and the no-fallback rule: the e-mail, the name or any other claim never leaves the provider.
    expect(verified.attributes).toEqual({ iss: idpA.issuer });
    expect(verified.evidence).toMatchObject({ method: "FEDERATED_OIDC", reasonCode: "OIDC_GENERIC_VERIFIED", externalObjectId: "subject-123" });
    expect(OIDC_GENERIC_PROFILE).toEqual({ displayName: "OIDC", subjectClaim: "sub" });
  });

  it("client authentication: client_secret_basic by default (F4-5), client_secret_post when configured", async () => {
    await signIn();
    expect(idpA.requests.filter((r) => r.path === "/token").map((r) => r.clientAuth)).toEqual(["client_secret_basic"]);
    idpA.reset();
    await signIn({ target: connection("conn-a", idpA.issuer, "luxia-a", "akv://luxia-test/oidc-a", HASH_A, { clientAuthMethod: "client_secret_post" }) });
    expect(idpA.requests.filter((r) => r.path === "/token").map((r) => r.clientAuth)).toEqual(["client_secret_post"]);
  });

  it("Microsoft regression: a profile that sets no client authentication keeps openid-client's default, client_secret_post", async () => {
    const { clientAuthMethod: _unset, ...withoutMethod } = A().client;
    void _unset;
    const gateway = new OpenIdClientOidcGateway(secrets(), undefined, guardedTestFetch([idpA]));
    const ctx = context(A());
    const begun = await gateway.begin(ctx, { displayName: "Profile", subjectClaim: "sub" }, withoutMethod);
    const { code, state } = idpA.authorize(begun.authorizationUrl, "subject-123");
    const verified = await gateway.complete(ctx, { displayName: "Profile", subjectClaim: "sub" }, withoutMethod,
      { currentUrl: callbackUrl({ code, state }).href, codeVerifier: begun.codeVerifier, expectedState: begun.state, expectedNonce: begun.nonce });
    expect(verified.subject).toBe("subject-123");
    expect(idpA.requests.filter((r) => r.path === "/token").map((r) => r.clientAuth)).toEqual(["client_secret_post"]);
  });

  // Rule R8, one case per check. Every refusal is AUTHENTICATION_FAILED with safe constants only.
  const refusals: Array<[string, TokenBehaviour, Record<string, unknown>]> = [
    ["a token from another issuer", { iss: "https://evil.luxia-test.example" }, { claim: "iss" }],
    ["a token for another audience", { aud: "someone-else" }, { claim: "aud" }],
    ["an invalid signature (a key the issuer never published)", { otherKey: true }, {}],
    ["an unsigned token (alg none)", { alg: "none" }, {}],
    ["an HMAC token (alg HS256, keyed with the client secret)", { alg: "HS256" }, {}],
    ["another algorithm than the pinned one (PS256, validly signed, when RS256 is configured)", { alg: "PS256" }, {}],
    ["an expired token", { expired: true }, { claim: "exp" }],
    ["a token issued in the future, beyond the 30 s tolerance", { iatOffset: 120 }, { reason: "ID_TOKEN_IAT_INVALID" }],
    ["a token issued after its own expiry", { iatOffset: 20, expOffset: 10 }, { reason: "ID_TOKEN_IAT_INVALID" }],
    ["a token issued at its own expiry", { iatOffset: 0, expOffset: 0 }, { reason: "ID_TOKEN_IAT_INVALID" }],
    ["a token without nonce", { nonce: null }, {}],
    ["a token with another nonce", { nonce: "replayed-nonce" }, { claim: "nonce" }],
    ["a token without sub", { sub: null }, {}],
  ];
  for (const [name, behaviour, details] of refusals) {
    it(`refuses ${name}`, async () => {
      const outcome = signIn({ behaviour });
      expect(await failure(outcome)).toMatchObject({ code: "AUTHENTICATION_FAILED", ...details });
      const error = await outcome.catch((e: unknown) => e);
      const visible = JSON.stringify(error) + String((error as Error)?.message) + String((error as Error)?.stack);
      for (const secret of [SECRET_A, SECRET_B, "subject-123", "test-access-token"]) expect(visible).not.toContain(secret);
    });
  }

  it("iat tolerance (documented: 30 s, openid-client's own tolerance on exp): 20 s ahead is accepted, 120 s is not", async () => {
    expect((await signIn({ behaviour: { iatOffset: 20 } })).identity.externalObjectId).toBe("subject-123");
    expect(await failure(signIn({ behaviour: { iatOffset: 120 } }))).toMatchObject({ reason: "ID_TOKEN_IAT_INVALID" });
  });

  it("refuses another state (CSRF), a missing state, and a state replayed into another round trip", async () => {
    expect(await failure(signIn({ callback: (code) => callbackUrl({ code, state: "forged-state" }) }))).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(await failure(signIn({ callback: (code) => callbackUrl({ code }) }))).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    const first = await begin(A());
    const { code } = idpA.authorize(first.redirectUrl!, "subject-123");
    const second = await begin(A());
    expect(await failure(complete(A(), second, callbackUrl({ code, state: first.transactionId })))).toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("refuses a wrong PKCE verifier: the provider rejects the code, nothing is accepted", async () => {
    const outcome = signIn({ overrides: { codeVerifier: "x".repeat(64) } });
    expect(await failure(outcome)).toMatchObject({ code: "AUTHENTICATION_FAILED", providerError: "invalid_grant" });
  });

  it("refuses a callback that names another issuer (RFC 9207 iss), before any token request", async () => {
    const outcome = signIn({ callback: (code, state) => callbackUrl({ code, state, iss: idpB.issuer }) });
    expect(await failure(outcome)).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(idpA.requests.filter((r) => r.path === "/token")).toEqual([]);
  });

  it("binds the round trip to its configuration: another hash, or none, is refused before any request to the provider", async () => {
    const begun = await begin(A());
    const { code, state } = idpA.authorize(begun.redirectUrl!, "subject-123");
    idpA.reset();
    expect(await failure(complete(A(), begun, callbackUrl({ code, state }), { expectedConfigurationHash: HASH_B })))
      .toMatchObject({ code: "AUTHENTICATION_FAILED", reason: "CONFIGURATION_CHANGED" });
    expect(await failure(complete(A(), begun, callbackUrl({ code, state }), { expectedConfigurationHash: "" })))
      .toMatchObject({ code: "INVALID_REQUEST" });
    expect(idpA.requests).toEqual([]);
  });

  describe("mix-up A -> B between two OIDC connections", () => {
    it("a code issued by provider B, brought back into connection A's round trip, is refused (B is never asked for a token)", async () => {
      const begunA = await begin(A());
      const begunB = await begin(B());
      const fromB = idpB.authorize(begunB.redirectUrl!, "subject-123");
      idpA.reset(); idpB.reset();
      expect(await failure(complete(A(), begunA, callbackUrl({ code: fromB.code, state: begunA.transactionId }))))
        .toMatchObject({ code: "AUTHENTICATION_FAILED", providerError: "invalid_grant" });
      expect(idpB.requests.filter((r) => r.path === "/token")).toEqual([]);
    });

    it("connection A's provider answering with a token issued and signed by provider B is refused", async () => {
      expect(await failure(signIn({ behaviour: { tokenFrom: idpB } }))).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    });

    it("two connections on one issuer: B's code is refused for A, and even a lax provider's token for B fails A's audience", async () => {
      const onShared = (id: string, clientId: string, key: string, hash: string) => connection(id, shared.issuer, clientId, key, hash);
      const a = onShared("conn-a", "luxia-a", "akv://luxia-test/oidc-a", HASH_A);
      const b = onShared("conn-b", "luxia-b", "akv://luxia-test/oidc-b", HASH_B);
      const begunA = await begin(a);
      const begunB = await begin(b);
      const forB = shared.authorize(begunB.redirectUrl!, "subject-123");
      expect(await failure(complete(a, begunA, callbackUrl({ code: forB.code, state: begunA.transactionId }))))
        .toMatchObject({ providerError: "invalid_grant" });
      // A broken provider (codes not bound to clients, PKCE skipped) issuing a token for luxia-b, even with A's nonce:
      // A's core refuses its audience.
      const forB2 = shared.authorize((await begin(b)).redirectUrl!, "subject-123");
      shared.behaviour = { lax: true, aud: "luxia-b", nonce: begunA.continuation!.nonce };
      const outcome = await failure(complete(a, begunA, callbackUrl({ code: forB2.code, state: begunA.transactionId })));
      expect(outcome).toMatchObject({ code: "AUTHENTICATION_FAILED", claim: "aud" });
    });
  });

  describe("guarded endpoints and outages", () => {
    it("refuses to send the browser to an authorization endpoint on a private address (guard) or over plain HTTP (openid-client)", async () => {
      idpA.behaviour = { authorizationEndpoint: "https://login.internal.example/authorize" };
      const dns = { "login.internal.example": ["10.0.0.5"] };
      expect(await failure(provider(A(), { dns }).beginAuthentication({ context: context(A()) })))
        .toMatchObject({ code: "AUTHENTICATION_FAILED", reason: "OUTBOUND_PRIVATE_ADDRESS" });
      idpA.behaviour = { authorizationEndpoint: "http://idp-a.luxia-test.example/authorize" };
      expect(await failure(provider(A()).beginAuthentication({ context: context(A()) })))
        .toMatchObject({ code: "AUTHENTICATION_FAILED", protocolCode: "OAUTH_HTTP_REQUEST_FORBIDDEN" });
    });

    it("an issuer on a private address is never contacted", async () => {
      const dns = { "idp-a.luxia-test.example": ["169.254.169.254"] };
      expect(await failure(provider(A(), { dns }).beginAuthentication({ context: context(A()) })))
        .toMatchObject({ code: "AUTHENTICATION_FAILED", reason: "OUTBOUND_PRIVATE_ADDRESS" });
      expect(idpA.requests).toEqual([]);
    });

    it("a provider outage fails with a safe, recognizable reason (network, or an error page at the token endpoint)", async () => {
      expect(await failure(signIn({ behaviour: { down: true } }))).toMatchObject({ code: "AUTHENTICATION_FAILED", reason: "OUTBOUND_NETWORK" });
      expect(await failure(signIn({ behaviour: { tokenStatus: 503 } }))).toMatchObject({ code: "AUTHENTICATION_FAILED", protocolCode: "OAUTH_RESPONSE_IS_NOT_CONFORM" });
    });

    it("until the vault is wired, the production store refuses every secret: no generic connection can sign in", async () => {
      expect(await failure(provider(A(), { store: new UnconfiguredSecretStore() }).beginAuthentication({ context: context(A()) })))
        .toMatchObject({ code: "SECRET_UNAVAILABLE", reason: "STORE_NOT_CONFIGURED" });
      expect(idpA.requests).toEqual([]);
    });
  });
});
