import { createHash, randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SecretLease, type SecretResolver } from "../../lib/provider-adapters";
import { OpenIdClientOidcGateway, type OidcClientConfig, type OidcProfile } from "../../lib/provider-adapters/implementations/oidc";
import { isPublicAddress } from "../../lib/provider-adapters/infrastructure/outbound/address-policy";
import {
  OutboundRefusedError, createGuardedFetch, type OutboundRequest, type OutboundResponse, type Resolve, type Send,
} from "../../lib/provider-adapters/infrastructure/outbound/guarded-fetch";

// F4, slice S1 (docs/architecture/F4-GENERIC-OIDC-CONNECTIONS-DESIGN.md, section 3; finding F4-S1): the SSRF-guarded
// transport under the OIDC core. The resolver and the transport are stubbed, so no test touches the network; the
// default transport (pinned HTTPS on port 443) is checked by the architecture test.

const reason = async (run: () => Promise<unknown>) => {
  try { await run(); return "ACCEPTED"; } catch (error) {
    if (error instanceof OutboundRefusedError) return error.reason;
    return (error as { safeDetails?: { reason?: string } }).safeDetails?.reason ?? (error as Error).message;
  }
};

describe("address policy: an identity provider is reached on a public address only", () => {
  const refused = [
    "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.5.4", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "239.255.255.250", "255.255.255.255", "240.0.0.1",
    "198.18.0.1", "198.19.255.255", "192.0.2.1", "198.51.100.7", "203.0.113.9", "192.0.0.8", "192.88.99.1",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:8.8.8.8",
    "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::1", "2001::1", "3fff::1", "100::1",
    "not-an-ip", "", "localhost", "1.2.3", "fe80::1%eth0",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "20.190.128.1", "172.32.0.1", "172.15.255.255", "100.128.0.1", "100.63.255.255",
    "192.169.0.1", "2606:4700:4700::1111", "2a01:4f8::1", "2620:1ec:c11::200"];
  for (const address of refused) it(`refuses ${address || "(empty)"}`, () => expect(isPublicAddress(address)).toBe(false));
  for (const address of allowed) it(`allows ${address}`, () => expect(isPublicAddress(address)).toBe(true));
});

describe("guarded fetch: refusals, pinning and limits", () => {
  const PUBLIC = "93.184.216.34";
  const ok = (body: unknown, status = 200): OutboundResponse =>
    ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
  const stub = (resolve: Resolve, send: Send = async () => ok({ ok: true })) => createGuardedFetch({ resolve, send });
  const publicResolve: Resolve = async () => [PUBLIC];

  it("refuses another scheme, another port, credentials or a fragment in the URL, before any lookup", async () => {
    let lookups = 0;
    const fetcher = stub(async () => { lookups++; return [PUBLIC]; });
    expect(await reason(() => fetcher("http://idp.example/.well-known/openid-configuration"))).toBe("OUTBOUND_SCHEME");
    expect(await reason(() => fetcher("https://idp.example:8443/x"))).toBe("OUTBOUND_PORT");
    expect(await reason(() => fetcher("https://user:pass@idp.example/x"))).toBe("OUTBOUND_URL");
    expect(await reason(() => fetcher("https://idp.example/x#fragment"))).toBe("OUTBOUND_URL");
    expect(await reason(() => fetcher("not a url"))).toBe("OUTBOUND_URL");
    expect(lookups).toBe(0);
    expect(await reason(() => fetcher("https://idp.example:443/x"))).toBe("ACCEPTED");
  });

  it("refuses a host that resolves to a private, loopback or metadata address, or to a mix of public and private", async () => {
    for (const addresses of [["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["::1"], ["fd00::1"], [PUBLIC, "10.0.0.5"], ["::ffff:127.0.0.1"]]) {
      expect(await reason(() => stub(async () => addresses)("https://idp.example/x")), addresses.join(",")).toBe("OUTBOUND_PRIVATE_ADDRESS");
    }
    expect(await reason(() => stub(async () => [])("https://idp.example/x"))).toBe("OUTBOUND_DNS");
    expect(await reason(() => stub(async () => { throw new Error("ENOTFOUND"); })("https://idp.example/x"))).toBe("OUTBOUND_DNS");
  });

  it("checks address literals without any lookup, IPv6 in brackets included", async () => {
    let lookups = 0;
    const fetcher = stub(async () => { lookups++; return [PUBLIC]; });
    expect(await reason(() => fetcher("https://169.254.169.254/metadata/instance"))).toBe("OUTBOUND_PRIVATE_ADDRESS");
    expect(await reason(() => fetcher("https://[::1]/x"))).toBe("OUTBOUND_PRIVATE_ADDRESS");
    expect(await reason(() => fetcher("https://[::ffff:a9fe:a9fe]/x"))).toBe("OUTBOUND_PRIVATE_ADDRESS");
    expect(await reason(() => fetcher(`https://${PUBLIC}/x`))).toBe("ACCEPTED");
    expect(lookups).toBe(0);
  });

  it("resolves once and sends to the validated address, so a second answer (DNS rebinding) is never used", async () => {
    let lookups = 0;
    const answers = [[PUBLIC], ["127.0.0.1"]];
    const sent: Array<{ host: string; pinned: string }> = [];
    const fetcher = stub(async () => answers[Math.min(lookups++, 1)], async (url, pinned) => { sent.push({ host: url.hostname, pinned }); return ok({}); });
    await fetcher("https://idp.example/.well-known/openid-configuration");
    expect(lookups).toBe(1);
    expect(sent).toEqual([{ host: "idp.example", pinned: PUBLIC }]);
  });

  it("refuses redirects and oversized answers; forwards the method, headers and form body; keeps a 204 empty", async () => {
    expect(await reason(() => stub(publicResolve, async () => ({ status: 302, headers: { location: "http://10.0.0.1/" }, body: Buffer.alloc(0) }))("https://idp.example/x"))).toBe("OUTBOUND_REDIRECT");
    expect(await reason(() => createGuardedFetch({ resolve: publicResolve, maxBytes: 10, send: async () => ok({ big: "x".repeat(100) }) })("https://idp.example/x"))).toBe("OUTBOUND_TOO_LARGE");
    let seen: OutboundRequest | undefined;
    const response = await stub(publicResolve, async (_url, _pinned, init) => { seen = init; return ok({ token: "t" }); })("https://idp.example/token", {
      method: "post", headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic abc" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "c" }),
    });
    expect(seen).toMatchObject({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic abc" }, timeoutMs: 5000, maxBytes: 524288 });
    expect(seen?.body?.toString()).toBe("grant_type=authorization_code&code=c");
    expect(await response.json()).toEqual({ token: "t" });
    const empty = await stub(publicResolve, async () => ({ status: 204, headers: {}, body: Buffer.alloc(0) }))("https://idp.example/x");
    expect(empty.status).toBe(204);
  });
});

// A complete identity provider in memory, at a public-looking HTTPS issuer, reached ONLY through the guard.
const ISSUER = "https://idp.luxia-test.example";
const CLIENT_ID = "luxia-test-client";
const CLIENT_SECRET = "guarded-test-secret-never-logged";
const PROFILE: OidcProfile = { displayName: "Guarded test IdP", subjectClaim: "sub" };
const context = { organizationId: "org-1", tenantId: "tenant-1", providerConnectionId: "conn-1", operationId: "op-1" };
const secrets: SecretResolver = {
  async withSecret(_context, _reference, consumer) {
    const lease = new SecretLease(new TextEncoder().encode(CLIENT_SECRET));
    try { return await consumer(lease); } finally { lease.dispose(); }
  },
};
let privateKey: CryptoKey; let publicJwk: JWK;
const grants = new Map<string, { challenge: string; nonce: string }>();
type Idp = { metadata?: Record<string, unknown>; discoveryStatus?: number; resolveMap?: Record<string, string[]>; requests: string[] };
let idp: Idp;
const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

const send: Send = async (url, pinned, init) => {
  idp.requests.push(`${init.method} ${url.host}${url.pathname} via ${pinned}`);
  const json = (status: number, body: unknown): OutboundResponse => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
  if (url.pathname === "/.well-known/openid-configuration") {
    if (idp.discoveryStatus) return { status: idp.discoveryStatus, headers: { location: "https://elsewhere.example/" }, body: Buffer.alloc(0) };
    return json(200, {
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"], ...idp.metadata,
    });
  }
  if (url.pathname === "/jwks") return json(200, { keys: [publicJwk] });
  if (url.pathname === "/token" && init.method === "POST") {
    const form = new URLSearchParams(init.body?.toString() ?? "");
    const basic = init.headers.authorization?.startsWith("Basic ")
      ? Buffer.from(init.headers.authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent) : null;
    const [id, secret] = basic ?? [form.get("client_id"), form.get("client_secret")];
    if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return json(401, { error: "invalid_client" });
    const grant = grants.get(form.get("code") ?? "");
    if (!grant || b64url(createHash("sha256").update(form.get("code_verifier") ?? "").digest()) !== grant.challenge) return json(400, { error: "invalid_grant" });
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ nonce: grant.nonce, sub: "guarded-subject" }).setIssuer(ISSUER).setAudience(CLIENT_ID)
      .setIssuedAt(now).setExpirationTime(now + 300).setProtectedHeader({ alg: "RS256", kid: "key-1" }).sign(privateKey);
    return json(200, { access_token: "a", token_type: "Bearer", expires_in: 300, id_token: idToken });
  }
  return json(404, { error: "not_found" });
};
const resolve: Resolve = async (host) => idp.resolveMap?.[host] ?? ["93.184.216.34"];
const gateway = () => new OpenIdClientOidcGateway(secrets, undefined, createGuardedFetch({ resolve, send }));
const config: OidcClientConfig = { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: { key: "s" }, redirectUri: "https://app.example/auth/callback" };

async function signIn() {
  const begun = await gateway().begin(context, PROFILE, config);
  const authorization = new URL(begun.authorizationUrl);
  const code = randomUUID();
  grants.set(code, { challenge: authorization.searchParams.get("code_challenge") ?? "", nonce: authorization.searchParams.get("nonce") ?? "" });
  const callback = new URL(config.redirectUri);
  callback.searchParams.set("code", code); callback.searchParams.set("state", begun.state);
  return gateway().complete(context, PROFILE, config, { currentUrl: callback.href, codeVerifier: begun.codeVerifier, expectedState: begun.state, expectedNonce: begun.nonce });
}

describe("the OIDC core goes through the guard for discovery, keys and token", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
  });
  beforeEach(() => { idp = { requests: [] }; });

  it("completes a genuine sign-in, every request pinned to the validated address", async () => {
    const verified = await signIn();
    expect(verified).toMatchObject({ subject: "guarded-subject", issuer: ISSUER });
    const paths = idp.requests.map((line) => line.replace(/^\w+ idp\.luxia-test\.example/, ""));
    expect(paths).toContain("/.well-known/openid-configuration via 93.184.216.34");
    expect(paths).toContain("/token via 93.184.216.34");
    expect(paths).toContain("/jwks via 93.184.216.34");
  });

  it("refuses an issuer on a private address before any request", async () => {
    idp.resolveMap = { "idp.luxia-test.example": ["10.20.30.40"] };
    expect(await reason(() => gateway().begin(context, PROFILE, config))).toBe("OUTBOUND_PRIVATE_ADDRESS");
    expect(idp.requests).toEqual([]);
  });

  it("refuses a redirect at discovery", async () => {
    idp.discoveryStatus = 302;
    expect(await reason(() => gateway().begin(context, PROFILE, config))).toBe("OUTBOUND_REDIRECT");
  });

  it("refuses keys published over plain HTTP, and a token endpoint on an internal host, at the sign-in's completion", async () => {
    // Two independent layers: the OIDC library refuses a non-HTTPS endpoint before calling fetch, and the guard would
    // refuse it too (OUTBOUND_SCHEME, tested above). No request reaches the transport.
    idp.metadata = { jwks_uri: "http://idp.luxia-test.example/jwks" };
    expect(await reason(signIn)).not.toBe("ACCEPTED");
    expect(idp.requests.some((line) => line.includes("/jwks"))).toBe(false);
    idp = { requests: [], metadata: { token_endpoint: "https://internal.luxia-test.example/token" }, resolveMap: { "internal.luxia-test.example": ["192.168.0.10"] } };
    expect(await reason(signIn)).toBe("OUTBOUND_PRIVATE_ADDRESS");
    expect(idp.requests.some((line) => line.includes("internal."))).toBe(false);
  });
});
