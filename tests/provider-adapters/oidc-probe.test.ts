import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { probeOidcIssuer, type OidcProbeInput } from "../../lib/provider-adapters/implementations/oidc/probe";
import { createGuardedFetch, type OutboundResponse, type Resolve, type Send } from "../../lib/provider-adapters/infrastructure/outbound/guarded-fetch";

// F4, slice S3: the connection test, run against an identity provider simulated in memory and reached only through the
// SSRF-guarded transport (stubbed resolver and transport: no network). One case per refusal.
const ISSUER = "https://idp.luxia-test.example";
const PUBLIC = "93.184.216.34";
const rsa = (bits: number) => ({ ...generateKeyPairSync("rsa", { modulusLength: bits }).publicKey.export({ format: "jwk" }), kid: `rsa-${bits}`, use: "sig" });
const RSA_2048 = rsa(2048);
const RSA_1024 = rsa(1024);
const EC_P256 = { ...generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" }), kid: "ec", use: "sig" };
const RSA_ENC = { ...rsa(2048), kid: "enc", use: "enc" };

type Idp = { metadata: Record<string, unknown>; keys: unknown[]; discoveryStatus?: number; contentType?: string; resolveMap: Record<string, string[]>; requests: string[] };
let idp: Idp;
const json = (status: number, body: unknown, contentType = "application/json"): OutboundResponse =>
  ({ status, headers: { "content-type": contentType }, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });
const send: Send = async (url) => {
  idp.requests.push(`${url.host}${url.pathname}`);
  if (url.pathname === "/.well-known/openid-configuration") {
    if (idp.discoveryStatus) return { status: idp.discoveryStatus, headers: { location: "https://elsewhere.example/" }, body: Buffer.alloc(0) };
    return json(200, idp.contentType === "text/html" ? "<html></html>" : idp.metadata, idp.contentType);
  }
  if (url.pathname === "/jwks") return json(200, { keys: idp.keys });
  return json(404, { error: "not_found" });
};
const resolve: Resolve = async (host) => idp.resolveMap[host] ?? [PUBLIC];
const probe = (input: Partial<OidcProbeInput> = {}) =>
  probeOidcIssuer({ issuer: ISSUER, idTokenAlgorithm: "RS256", clientAuthMethod: "client_secret_basic", ...input },
    { fetch: createGuardedFetch({ resolve, send }), resolve });

beforeEach(() => {
  idp = {
    metadata: {
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    },
    keys: [RSA_2048], resolveMap: {}, requests: [],
  };
});

describe("connection test (S3): what the sign-in relies on, checked without any user", () => {
  it("passes for a compliant provider and records hosts, counts and key types only", async () => {
    const result = await probe();
    expect(result).toMatchObject({ outcome: "PASSED", reasonCode: "DISCOVERY_PASSED" });
    expect(result.metadata).toMatchObject({ issuerHost: "idp.luxia-test.example", authorizationHost: "idp.luxia-test.example",
      tokenHost: "idp.luxia-test.example", jwksHost: "idp.luxia-test.example", usableKeys: 1, signingKeys: 1, keyTypes: ["RSA-2048"], advertisesNone: false });
    const recorded = JSON.stringify(result.metadata);
    for (const forbidden of ["/.well-known", "/jwks", "/authorize", "https://", PUBLIC, RSA_2048.n as string]) expect(recorded).not.toContain(forbidden);
    expect(idp.requests).toEqual(["idp.luxia-test.example/.well-known/openid-configuration", "idp.luxia-test.example/jwks"]);
  });

  it("accepts the discovery default when the client authentication list is absent (client_secret_basic only)", async () => {
    delete idp.metadata.token_endpoint_auth_methods_supported;
    expect((await probe()).outcome).toBe("PASSED");
    expect((await probe({ clientAuthMethod: "client_secret_post" })).reasonCode).toBe("DISCOVERY_CLIENT_AUTH_UNSUPPORTED");
  });

  it("records, without failing, a provider that also advertises unsigned tokens (LUXIA pins its algorithm)", async () => {
    idp.metadata.id_token_signing_alg_values_supported = ["RS256", "none"];
    expect(await probe()).toMatchObject({ outcome: "PASSED", metadata: { advertisesNone: true } });
  });

  it("verifies ES256 with an EC P-256 key", async () => {
    idp.metadata.id_token_signing_alg_values_supported = ["ES256"];
    idp.keys = [EC_P256];
    expect(await probe({ idTokenAlgorithm: "ES256" })).toMatchObject({ outcome: "PASSED", metadata: { keyTypes: ["EC-P-256"] } });
  });

  const refusals: Array<[string, (idp: Idp) => void, Partial<OidcProbeInput>, string]> = [
    ["an issuer on a private address, before any request", (p) => { p.resolveMap["idp.luxia-test.example"] = ["10.1.2.3"]; }, {}, "OUTBOUND_PRIVATE_ADDRESS"],
    ["a redirect at discovery", (p) => { p.discoveryStatus = 302; }, {}, "OUTBOUND_REDIRECT"],
    ["a missing discovery document", (p) => { p.discoveryStatus = 404; }, {}, "DISCOVERY_HTTP_STATUS"],
    ["an HTML page instead of JSON", (p) => { p.contentType = "text/html"; }, {}, "DISCOVERY_NOT_JSON"],
    ["another issuer in the document", (p) => { p.metadata.issuer = "https://evil.luxia-test.example"; }, {}, "DISCOVERY_ISSUER_MISMATCH"],
    ["a trailing-slash drift of the issuer", (p) => { p.metadata.issuer = `${ISSUER}/`; }, {}, "DISCOVERY_ISSUER_MISMATCH"],
    ["no keys endpoint", (p) => { delete p.metadata.jwks_uri; }, {}, "DISCOVERY_ENDPOINT_MISSING"],
    ["an authorization endpoint over plain HTTP", (p) => { p.metadata.authorization_endpoint = "http://idp.luxia-test.example/authorize"; }, {}, "OUTBOUND_SCHEME"],
    ["an authorization endpoint on an internal host", (p) => { p.metadata.authorization_endpoint = "https://login.internal.example/authorize"; p.resolveMap["login.internal.example"] = ["192.168.1.20"]; }, {}, "OUTBOUND_PRIVATE_ADDRESS"],
    ["keys on an internal host", (p) => { p.metadata.jwks_uri = "https://keys.internal.example/jwks"; p.resolveMap["keys.internal.example"] = ["169.254.169.254"]; }, {}, "OUTBOUND_PRIVATE_ADDRESS"],
    ["no code flow", (p) => { p.metadata.response_types_supported = ["id_token"]; }, {}, "DISCOVERY_CODE_FLOW_UNSUPPORTED"],
    ["no PKCE S256", (p) => { p.metadata.code_challenge_methods_supported = ["plain"]; }, {}, "DISCOVERY_PKCE_S256_UNSUPPORTED"],
    ["PKCE not advertised at all", (p) => { delete p.metadata.code_challenge_methods_supported; }, {}, "DISCOVERY_PKCE_S256_UNSUPPORTED"],
    ["the configured algorithm unsupported", (p) => { p.metadata.id_token_signing_alg_values_supported = ["RS256"]; }, { idTokenAlgorithm: "PS256" }, "DISCOVERY_ALGORITHM_UNSUPPORTED"],
    ["the configured client authentication unsupported", (p) => { p.metadata.token_endpoint_auth_methods_supported = ["private_key_jwt"]; }, {}, "DISCOVERY_CLIENT_AUTH_UNSUPPORTED"],
    ["only a weak RSA key", (p) => { p.keys = [RSA_1024]; }, {}, "JWKS_WEAK_KEY"],
    ["only an encryption key", (p) => { p.keys = [RSA_ENC]; }, {}, "JWKS_NO_USABLE_KEY"],
    ["no key at all", (p) => { p.keys = []; }, {}, "JWKS_NO_USABLE_KEY"],
    ["a key bound to another algorithm", (p) => { p.keys = [{ ...RSA_2048, alg: "RS512" }]; }, {}, "JWKS_NO_USABLE_KEY"],
    ["ES256 configured, RSA keys only", (p) => { p.metadata.id_token_signing_alg_values_supported = ["ES256"]; }, { idTokenAlgorithm: "ES256" }, "JWKS_NO_USABLE_KEY"],
  ];
  for (const [name, setup, input, reason] of refusals) {
    it(`fails on ${name} (${reason})`, async () => {
      setup(idp);
      const result = await probe(input);
      expect(result).toMatchObject({ outcome: "FAILED", reasonCode: reason });
      if (reason === "OUTBOUND_PRIVATE_ADDRESS" && name.startsWith("an issuer")) expect(idp.requests).toEqual([]);
    });
  }

  it("never throws: an unexpected failure is a recorded PROBE_FAILED", async () => {
    const result = await probeOidcIssuer({ issuer: ISSUER, idTokenAlgorithm: "RS256", clientAuthMethod: "client_secret_basic" },
      { fetch: (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch, resolve });
    expect(result).toMatchObject({ outcome: "FAILED", reasonCode: "PROBE_FAILED" });
  });
});
