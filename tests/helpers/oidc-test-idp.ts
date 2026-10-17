import { createHash, randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { SecretLease, type SecretResolver } from "../../lib/provider-adapters";
import {
  OutboundRefusedError, createGuardedFetch, type OutboundResponse, type Resolve, type Send,
} from "../../lib/provider-adapters/infrastructure/outbound/guarded-fetch";

// F4 test kit: OpenID providers simulated in memory and reached ONLY through the SSRF-guarded transport (stubbed DNS and
// transport, no network). Each provider has a real discovery document, published keys, a token endpoint that checks the
// client authentication, the code's client and PKCE S256, and signs real ID tokens. A behaviour switch per provider
// produces each token the core must refuse (rule R8). Test secrets only: none of them is a real credential.
export const PUBLIC_ADDRESS = "93.184.216.34";

export type TokenBehaviour = {
  iss?: string;
  aud?: string;
  /** null: the claim is left out. */
  sub?: string | null;
  nonce?: string | null;
  alg?: "RS256" | "PS256" | "HS256" | "none";
  /** Signed by a key the provider never published. */
  otherKey?: boolean;
  expired?: boolean;
  /** Seconds added to "now" for iat (and to exp, unless expOffset is given). */
  iatOffset?: number;
  /** exp relative to now, in seconds (default iat + 300). */
  expOffset?: number;
  /** Extra claims a provider might try to grant authority with. */
  extraClaims?: Record<string, unknown>;
  /** The token endpoint answers this HTTP status with no token (outage). */
  tokenStatus?: number;
  /** Every request to this provider fails at the network level (outage). */
  down?: boolean;
  /** A broken provider: accepts a code issued to another client and skips PKCE, so that LUXIA's own checks refuse. */
  lax?: boolean;
  /** Return an ID token signed by another provider entirely (its issuer and key). */
  tokenFrom?: TestIdp;
  /** Publish another authorization endpoint in discovery. */
  authorizationEndpoint?: string;
};

type Grant = { challenge: string; nonce: string; clientId: string; sub: string; redirectUri: string };

export class TestIdp {
  behaviour: TokenBehaviour = {};
  readonly requests: Array<{ path: string; method: string; clientAuth?: "client_secret_basic" | "client_secret_post" }> = [];
  private readonly grants = new Map<string, Grant>();

  private constructor(
    readonly issuer: string,
    private readonly clients: Record<string, string>,
    private readonly rsa: CryptoKey,
    private readonly pss: CryptoKey,
    private readonly other: CryptoKey,
    private readonly jwks: JWK[],
  ) {}

  static async create(issuer: string, clients: Record<string, string>): Promise<TestIdp> {
    const rsa = await generateKeyPair("RS256", { extractable: true });
    const pss = await generateKeyPair("PS256", { extractable: true });
    const other = await generateKeyPair("RS256");
    const jwks = [
      { ...(await exportJWK(rsa.publicKey)), kid: "rs-1", alg: "RS256", use: "sig" },
      { ...(await exportJWK(pss.publicKey)), kid: "ps-1", alg: "PS256", use: "sig" },
    ];
    return new TestIdp(issuer, clients, rsa.privateKey, pss.privateKey, other.privateKey, jwks);
  }

  get host(): string { return new URL(this.issuer).host; }

  reset(): void {
    this.behaviour = {};
    this.requests.length = 0;
    this.grants.clear();
  }

  /** The person signs in at the provider: it issues a code for the authorization request, bound to its PKCE challenge. */
  authorize(authorizationUrl: string, sub: string): { code: string; state: string } {
    const request = new URL(authorizationUrl);
    if (`${request.protocol}//${request.host}` !== new URL(this.issuer).origin) throw new Error("NOT_THIS_PROVIDER");
    const code = randomUUID();
    this.grants.set(code, {
      challenge: request.searchParams.get("code_challenge") ?? "", nonce: request.searchParams.get("nonce") ?? "",
      clientId: request.searchParams.get("client_id") ?? "", sub, redirectUri: request.searchParams.get("redirect_uri") ?? "",
    });
    return { code, state: request.searchParams.get("state") ?? "" };
  }

  async handle(url: URL, method: string, headers: Record<string, string>, body?: Buffer): Promise<OutboundResponse> {
    if (this.behaviour.down) throw new OutboundRefusedError("OUTBOUND_NETWORK");
    const json = (status: number, payload: unknown): OutboundResponse =>
      ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(payload)) });
    if (url.pathname === "/.well-known/openid-configuration") {
      this.requests.push({ path: url.pathname, method });
      return json(200, {
        issuer: this.issuer, authorization_endpoint: this.behaviour.authorizationEndpoint ?? `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256", "PS256"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    }
    if (url.pathname === "/jwks") {
      this.requests.push({ path: url.pathname, method });
      return json(200, { keys: this.jwks });
    }
    if (url.pathname === "/token" && method === "POST") {
      const form = new URLSearchParams(body?.toString() ?? "");
      const authorization = headers.authorization ?? "";
      const basic = authorization.startsWith("Basic ")
        ? Buffer.from(authorization.slice(6), "base64").toString().split(":").map((part) => decodeURIComponent(part.replace(/\+/g, " ")))
        : null;
      const clientAuth = basic ? "client_secret_basic" as const : "client_secret_post" as const;
      this.requests.push({ path: url.pathname, method, clientAuth });
      if (this.behaviour.tokenStatus) return { status: this.behaviour.tokenStatus, headers: { "content-type": "text/html" }, body: Buffer.from("<html>down</html>") };
      const [clientId, secret] = basic ?? [form.get("client_id"), form.get("client_secret")];
      if (!clientId || this.clients[clientId] === undefined || this.clients[clientId] !== secret) return json(401, { error: "invalid_client" });
      const grant = this.grants.get(form.get("code") ?? "");
      if (!grant) return json(400, { error: "invalid_grant" });
      this.grants.delete(form.get("code") ?? "");
      if (grant.clientId !== clientId && !this.behaviour.lax) return json(400, { error: "invalid_grant" });
      if (grant.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
      const verifier = form.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== grant.challenge && !this.behaviour.lax) return json(400, { error: "invalid_grant" });
      const signer = this.behaviour.tokenFrom ?? this;
      return json(200, { access_token: "test-access-token", token_type: "Bearer", expires_in: 300,
        id_token: await signer.idToken(grant, clientId, this.behaviour) });
    }
    return json(404, { error: "not_found" });
  }

  private async idToken(grant: Grant, clientId: string, behaviour: TokenBehaviour): Promise<string> {
    const claims: Record<string, unknown> = { ...(behaviour.extraClaims ?? {}) };
    if (behaviour.sub !== null) claims.sub = behaviour.sub ?? grant.sub;
    if (behaviour.nonce !== null) claims.nonce = behaviour.nonce ?? grant.nonce;
    const now = Math.floor(Date.now() / 1000);
    const iat = behaviour.expired ? now - 3600 : now + (behaviour.iatOffset ?? 0);
    const exp = behaviour.expired ? now - 1800 : behaviour.expOffset !== undefined ? now + behaviour.expOffset : iat + 300;
    const iss = behaviour.iss ?? this.issuer;
    const aud = behaviour.aud ?? clientId;
    if (behaviour.alg === "none") {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      return `${encode({ alg: "none", typ: "JWT" })}.${encode({ ...claims, iss, aud, iat, exp })}.`;
    }
    const jwt = new SignJWT(claims).setIssuer(iss).setAudience(aud).setIssuedAt(iat).setExpirationTime(exp);
    if (behaviour.alg === "HS256") return jwt.setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(this.clients[clientId] ?? "x"));
    if (behaviour.alg === "PS256") return jwt.setProtectedHeader({ alg: "PS256", kid: "ps-1" }).sign(this.pss);
    return jwt.setProtectedHeader({ alg: "RS256", kid: "rs-1" }).sign(behaviour.otherKey ? this.other : this.rsa);
  }
}

/** DNS stub: every test provider host resolves to a public address, unless the test says otherwise. */
export function resolver(overrides: Record<string, string[]> = {}): Resolve {
  return async (host) => overrides[host] ?? [PUBLIC_ADDRESS];
}

/** The transport stub behind the guard: each request goes to the simulated provider that owns the host. */
export function transport(idps: TestIdp[]): Send {
  return async (url, _address, init) => {
    const idp = idps.find((candidate) => candidate.host === url.host);
    if (!idp) throw new OutboundRefusedError("OUTBOUND_NETWORK");
    return idp.handle(url, init.method, init.headers, init.body);
  };
}

/** The SSRF-guarded fetch the production code uses, with the stubs above in place of DNS and the network. */
export function guardedTestFetch(idps: TestIdp[], overrides: Record<string, string[]> = {}): typeof fetch {
  return createGuardedFetch({ resolve: resolver(overrides), send: transport(idps) });
}

/** A secret store serving test secrets by reference (the vault stand-in); unknown references are unavailable. */
export function testSecretStore(values: Record<string, string>): SecretResolver & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async withSecret(_context, reference, consumer) {
      reads.push(reference.key);
      const value = values[reference.key];
      if (value === undefined) throw new Error("TEST_SECRET_UNKNOWN");
      const lease = new SecretLease(new TextEncoder().encode(value));
      try { return await consumer(lease); } finally { lease.dispose(); }
    },
  };
}
