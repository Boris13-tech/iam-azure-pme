import {
  OutboundRefusedError, checkOutboundTarget, createGuardedFetch, type Resolve,
} from "../../infrastructure/outbound/guarded-fetch";

// F4, slice S3 (docs/architecture/F4-GENERIC-OIDC-CONNECTIONS-DESIGN.md, sections 3 and 4): the connection test, run
// without any user. It reads the issuer's discovery document and keys through the SSRF-guarded transport only, and
// checks what the sign-in will rely on: the exact issuer, HTTPS endpoints on public hosts, the code flow with PKCE S256,
// the configured ID token algorithm and client authentication, and at least one usable signing key. The result holds
// safe codes, counts and host names only: never a URL path, an address, a key or a token.
export type OidcProbeInput = Readonly<{
  issuer: string;
  idTokenAlgorithm: "RS256" | "PS256" | "ES256";
  clientAuthMethod: "client_secret_basic" | "client_secret_post";
}>;
export type OidcProbeResult = Readonly<{
  outcome: "PASSED" | "FAILED";
  reasonCode: string;
  metadata: Record<string, string | number | boolean | string[]>;
}>;
export type OidcProbeOptions = Readonly<{ fetch?: typeof fetch; resolve?: Resolve }>;

class ProbeFailure extends Error {
  constructor(readonly reasonCode: string) { super(reasonCode); }
}
const fail = (reasonCode: string): never => { throw new ProbeFailure(reasonCode); };
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export async function probeOidcIssuer(input: OidcProbeInput, options: OidcProbeOptions = {}): Promise<OidcProbeResult> {
  const fetcher = options.fetch ?? createGuardedFetch(options.resolve ? { resolve: options.resolve } : {});
  const metadata: Record<string, string | number | boolean | string[]> = {};
  try {
    metadata.issuerHost = new URL(input.issuer).hostname;
    const discovery = await getJson(fetcher, `${input.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, "DISCOVERY");
    if (discovery.issuer !== input.issuer) fail("DISCOVERY_ISSUER_MISMATCH");

    const endpoints: Record<string, string> = {};
    for (const name of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      const value = discovery[name];
      if (typeof value !== "string" || !value) fail("DISCOVERY_ENDPOINT_MISSING");
      endpoints[name] = value as string;
    }
    // The authorization endpoint is only shown to the browser; it must still be HTTPS on a public host.
    const authorization = await checkOutboundTarget(endpoints.authorization_endpoint, options.resolve);
    metadata.authorizationHost = authorization.url.hostname;
    metadata.tokenHost = new URL(endpoints.token_endpoint).hostname;
    metadata.jwksHost = new URL(endpoints.jwks_uri).hostname;

    if (!strings(discovery.response_types_supported).includes("code")) fail("DISCOVERY_CODE_FLOW_UNSUPPORTED");
    if (!strings(discovery.code_challenge_methods_supported).includes("S256")) fail("DISCOVERY_PKCE_S256_UNSUPPORTED");
    const algorithms = strings(discovery.id_token_signing_alg_values_supported);
    metadata.algorithms = algorithms.slice(0, 12);
    // A provider that also offers unsigned tokens is recorded; LUXIA pins its algorithm, so it is not a failure.
    metadata.advertisesNone = algorithms.includes("none");
    if (!algorithms.includes(input.idTokenAlgorithm)) fail("DISCOVERY_ALGORITHM_UNSUPPORTED");
    // OIDC Discovery: when the list is absent, client_secret_basic is the default.
    const authMethods = discovery.token_endpoint_auth_methods_supported === undefined
      ? ["client_secret_basic"] : strings(discovery.token_endpoint_auth_methods_supported);
    metadata.clientAuthMethods = authMethods.slice(0, 8);
    if (!authMethods.includes(input.clientAuthMethod)) fail("DISCOVERY_CLIENT_AUTH_UNSUPPORTED");

    const jwks = await getJson(fetcher, endpoints.jwks_uri, "JWKS");
    if (!Array.isArray(jwks.keys)) fail("JWKS_INVALID");
    const keys = (jwks.keys as unknown[]).filter((key): key is Record<string, unknown> => typeof key === "object" && key !== null);
    const signing = keys.filter((key) => key.use === undefined || key.use === "sig");
    const described = signing.map((key) => describeKey(key, input.idTokenAlgorithm));
    metadata.signingKeys = signing.length;
    metadata.usableKeys = described.filter((key) => key.usable).length;
    metadata.keyTypes = [...new Set(described.map((key) => key.label))].slice(0, 8);
    if (!described.some((key) => key.usable)) fail(described.some((key) => key.weak) ? "JWKS_WEAK_KEY" : "JWKS_NO_USABLE_KEY");

    return { outcome: "PASSED", reasonCode: "DISCOVERY_PASSED", metadata };
  } catch (error) {
    const reasonCode = error instanceof ProbeFailure ? error.reasonCode
      : error instanceof OutboundRefusedError ? error.reason
      : "PROBE_FAILED";
    return { outcome: "FAILED", reasonCode, metadata };
  }
}

async function getJson(fetcher: typeof fetch, url: string, stage: "DISCOVERY" | "JWKS"): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { method: "GET", headers: { accept: "application/json" }, redirect: "manual" });
  if (response.status !== 200) fail(`${stage}_HTTP_STATUS`);
  if (!/^application\/([a-z.+-]*\+)?json\b/i.test(response.headers.get("content-type") ?? "")) fail(`${stage}_NOT_JSON`);
  const body = await response.json().catch(() => fail(`${stage}_NOT_JSON`));
  if (typeof body !== "object" || body === null || Array.isArray(body)) fail(`${stage}_NOT_JSON`);
  return body as Record<string, unknown>;
}

/** Whether a JWK can verify the configured algorithm: RSA of 2048 bits or more (RS256, PS256), or EC P-256 (ES256). */
function describeKey(key: Record<string, unknown>, algorithm: OidcProbeInput["idTokenAlgorithm"]): { usable: boolean; weak: boolean; label: string } {
  const algOk = key.alg === undefined || key.alg === algorithm;
  if (key.kty === "RSA" && typeof key.n === "string") {
    const bytes = Buffer.from(key.n, "base64url");
    let start = 0;
    while (start < bytes.length && bytes[start] === 0) start++;
    const bits = (bytes.length - start) * 8;
    const strong = bits >= 2048;
    const label = `RSA-${bits >= 4096 ? 4096 : bits >= 3072 ? 3072 : bits >= 2048 ? 2048 : bits}`;
    return { usable: algorithm !== "ES256" && algOk && strong, weak: algorithm !== "ES256" && algOk && !strong, label };
  }
  if (key.kty === "EC" && typeof key.x === "string" && typeof key.y === "string") {
    return { usable: algorithm === "ES256" && algOk && key.crv === "P-256", weak: false, label: `EC-${typeof key.crv === "string" ? key.crv : "?"}` };
  }
  return { usable: false, weak: false, label: typeof key.kty === "string" ? key.kty : "?" };
}
