import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProviderAdapterError, type ProviderOperationContext } from "../../lib/provider-adapters";
import { EnvironmentSecretResolver } from "../../lib/provider-adapters/infrastructure/environment-secret-resolver";
import {
  AzureKeyVaultSecretResolver, CachingSecretResolver, FederatedWorkloadTokenProvider,
  assertSecretStoreAllowed, parseSecretReference,
} from "../../lib/provider-adapters/infrastructure/secret-stores";

// F3 (docs/architecture/F3-SECRET-STORE-DESIGN.md): the vault adapter, the secretless token, the cache and the
// Production guard, against local fake endpoints (no network, no real vault).
const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "66666666-7777-4888-8999-000000000000";
const VERSION = "0123456789abcdef0123456789abcdef";
const SECRET_VALUE = "s3cr3t-value-never-logged";
const ctx = (organizationId = "org-a", providerConnectionId = "conn-1"): ProviderOperationContext =>
  ({ organizationId, tenantId: "tenant-a", providerConnectionId, operationId: "op-1" });
const reason = async (run: Promise<unknown>) => { try { await run; return "OK"; } catch (error) {
  const e = error as ProviderAdapterError; return `${e.code}:${e.safeDetails?.reason}:${e.retryable ? "retry" : "final"}`; } };
const read = (resolver: { withSecret: AzureKeyVaultSecretResolver["withSecret"] }, ref = { key: "akv://luxia-app-kv/entra-oidc-conn-1" }, c = ctx()) =>
  resolver.withSecret(c, ref, async (lease) => lease.read((bytes) => new TextDecoder().decode(bytes)));

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let handler: Handler;
let base = "";
const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
const server = createServer((req, res) => {
  let body = ""; req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body }); handler(req, res, body); });
});
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
const vault = (tokens = { token: async () => "vault-token" }) =>
  new AzureKeyVaultSecretResolver({ tokens, timeoutMs: 300, vaultUrl: (name) => `${base}/vault/${name}` });

beforeAll(async () => { await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { seen.length = 0; handler = (_req, res) => json(res, 200, { value: SECRET_VALUE, attributes: { enabled: true } }); });

describe("secret references", () => {
  it("accepts vault and environment locators only, never a path or a value", () => {
    expect(parseSecretReference({ key: "akv://luxia-app-kv/entra-oidc-conn-1", version: VERSION })).toEqual({ store: "azure-key-vault", vault: "luxia-app-kv", name: "entra-oidc-conn-1", version: VERSION });
    expect(parseSecretReference({ key: "ENTRA_AUTH_CLIENT_SECRET" })).toEqual({ store: "environment", name: "ENTRA_AUTH_CLIENT_SECRET" });
    expect(parseSecretReference({ key: "env://GRAPH_CLIENT_SECRET" })).toEqual({ store: "environment", name: "GRAPH_CLIENT_SECRET" });
    for (const key of ["akv://luxia-app-kv/../other", "akv://a/x", "akv://luxia--kv/x", "akv://luxia-app-kv/x/y", "akv://luxia-app-kv/a_b", "lower_case", "https://evil.example/x", ""])
      expect(() => parseSecretReference({ key }), key).toThrow(/Invalid secret reference/);
    expect(() => parseSecretReference({ key: "akv://luxia-app-kv/x", version: "latest" })).toThrow(/Invalid secret reference/);
  });
});

describe("Azure Key Vault adapter (REST, no SDK)", () => {
  it("reads the latest or a pinned version with the bearer token, and hands the value only through a redacted lease", async () => {
    expect(await read(vault())).toBe(SECRET_VALUE);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/vault/luxia-app-kv/secrets/entra-oidc-conn-1?api-version=7.4", auth: "Bearer vault-token" });
    expect(await read(vault(), { key: "akv://luxia-app-kv/entra-oidc-conn-1", version: VERSION } as never)).toBe(SECRET_VALUE);
    expect(seen[1].url).toBe(`/vault/luxia-app-kv/secrets/entra-oidc-conn-1/${VERSION}?api-version=7.4`);
    await vault().withSecret(ctx(), { key: "akv://luxia-app-kv/x" }, async (lease) => {
      expect(String(lease)).toBe("[REDACTED]"); expect(JSON.stringify({ lease })).not.toContain(SECRET_VALUE);
    });
  });

  it("maps every store answer to a safe reason: denied and missing fail closed, outages are retryable", async () => {
    const cases: Array<[number | "slow" | "redirect" | "disabled" | "empty" | "garbage", string]> = [
      [403, "SECRET_UNAVAILABLE:STORE_DENIED:final"], [401, "SECRET_UNAVAILABLE:STORE_DENIED:final"], [404, "SECRET_UNAVAILABLE:NOT_FOUND:final"],
      [500, "SECRET_UNAVAILABLE:STORE_UNAVAILABLE:retry"], [503, "SECRET_UNAVAILABLE:STORE_UNAVAILABLE:retry"], [429, "SECRET_UNAVAILABLE:STORE_UNAVAILABLE:retry"],
      ["slow", "TIMEOUT:STORE_TIMEOUT:retry"], ["redirect", "SECRET_UNAVAILABLE:STORE_UNAVAILABLE:retry"],
      ["disabled", "SECRET_UNAVAILABLE:DISABLED:final"], ["empty", "SECRET_UNAVAILABLE:EMPTY:final"], ["garbage", "SECRET_UNAVAILABLE:STORE_UNEXPECTED_RESPONSE:final"],
    ];
    for (const [answer, expected] of cases) {
      handler = (_req, res) => {
        if (answer === "slow") { setTimeout(() => json(res, 200, { value: SECRET_VALUE }), 1_000); return; }
        if (answer === "redirect") { res.writeHead(302, { location: "https://elsewhere.example/" }); res.end(); return; }
        if (answer === "disabled") return json(res, 200, { value: SECRET_VALUE, attributes: { enabled: false } });
        if (answer === "empty") return json(res, 200, { value: "" });
        if (answer === "garbage") { res.writeHead(200, { "content-type": "application/json" }); res.end("{not json"); return; }
        json(res, answer, { error: { code: "x", message: `echo ${SECRET_VALUE}` } });
      };
      expect(await reason(read(vault())), String(answer)).toBe(expected);
    }
    // An error never carries the value, the token or the URL.
    handler = (_req, res) => json(res, 403, { error: { message: SECRET_VALUE } });
    const error = await read(vault()).catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toMatch(new RegExp(`${SECRET_VALUE}|vault-token|127\\.0\\.0\\.1`));
    expect((error as ProviderAdapterError).safeDetails).toEqual({ reason: "STORE_DENIED", vault: "luxia-app-kv", secret: "entra-oidc-conn-1" });
  });

  it("refuses an environment reference: the vault adapter serves vault locators only", async () => {
    expect(await reason(read(vault(), { key: "ENTRA_AUTH_CLIENT_SECRET" }))).toBe("SECRET_UNAVAILABLE:INVALID_REFERENCE:final");
    expect(seen).toHaveLength(0);
  });
});

describe("workload identity token (no stored secret)", () => {
  const assertion = async () => "header.payload.signature";
  const provider = (now = () => 1_000_000, extra: Partial<ConstructorParameters<typeof FederatedWorkloadTokenProvider>[0]> = {}) =>
    new FederatedWorkloadTokenProvider({ tenantId: TENANT, clientId: CLIENT, assertion, authorityUrl: `${base}/login`, now, ...extra });

  it("exchanges the platform assertion with client credentials, caches the token, refreshes before expiry, one request at a time", async () => {
    handler = (_req, res) => json(res, 200, { access_token: `tok-${seen.length}`, expires_in: 3600 });
    let now = 1_000_000;
    const tokens = provider(() => now);
    expect(await Promise.all([tokens.token(), tokens.token(), tokens.token()])).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`/login/${TENANT}/oauth2/v2.0/token`);
    const form = new URLSearchParams(seen[0].body);
    expect(Object.fromEntries(form)).toEqual({ client_id: CLIENT, scope: "https://vault.azure.net/.default", grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: "header.payload.signature" });
    now += 54 * 60_000; expect(await tokens.token()).toBe("tok-1");   // still more than 5 minutes left
    now += 2 * 60_000; expect(await tokens.token()).toBe("tok-2");    // refreshed 5 minutes before expiry
  });

  it("fails safely: denied is final, outages are retryable, a broken assertion never reaches the endpoint", async () => {
    for (const [status, expected] of [[400, "WORKLOAD_IDENTITY_DENIED:final"], [401, "WORKLOAD_IDENTITY_DENIED:final"], [503, "TOKEN_ENDPOINT_UNAVAILABLE:retry"], [429, "TOKEN_ENDPOINT_UNAVAILABLE:retry"]] as const) {
      handler = (_req, res) => json(res, status, { error: "x" });
      expect(await reason(provider().token())).toBe(`SECRET_UNAVAILABLE:${expected}`);
    }
    seen.length = 0;
    expect(await reason(provider(undefined, { assertion: async () => { throw new Error("no token"); } }).token())).toBe("SECRET_UNAVAILABLE:WORKLOAD_ASSERTION_UNAVAILABLE:retry");
    expect(await reason(provider(undefined, { assertion: async () => "not-a-jwt" }).token())).toBe("SECRET_UNAVAILABLE:WORKLOAD_ASSERTION_INVALID:final");
    expect(seen).toHaveLength(0);
    expect(() => new FederatedWorkloadTokenProvider({ tenantId: "common", clientId: CLIENT, assertion })).toThrow(/Invalid workload identity configuration/);
  });
});

describe("cache with a bounded stale-if-error window", () => {
  it("serves within the TTL, refreshes after it, bridges only transient outages and only for the window", async () => {
    let now = 0;
    const cached = new CachingSecretResolver(vault(), { ttlMs: 5 * 60_000, staleIfErrorMs: 60 * 60_000, now: () => now });
    expect(await read(cached)).toBe(SECRET_VALUE); expect(await read(cached)).toBe(SECRET_VALUE);
    expect(seen).toHaveLength(1);
    now += 6 * 60_000; await read(cached); expect(seen).toHaveLength(2);
    handler = (_req, res) => json(res, 503, {});
    now += 10 * 60_000; expect(await read(cached)).toBe(SECRET_VALUE);          // outage, 10 min after the last read: stale
    now += 55 * 60_000; expect(await reason(read(cached))).toBe("SECRET_UNAVAILABLE:STORE_UNAVAILABLE:retry"); // beyond 60 min
  });

  it("a denied or missing secret evicts at once, even inside the window (revocation is immediate)", async () => {
    let now = 0;
    const cached = new CachingSecretResolver(vault(), { now: () => now });
    await read(cached);
    now += 6 * 60_000; handler = (_req, res) => json(res, 403, {});
    expect(await reason(read(cached))).toBe("SECRET_UNAVAILABLE:STORE_DENIED:final");
    handler = (_req, res) => json(res, 503, {});
    expect(await reason(read(cached))).toBe("SECRET_UNAVAILABLE:STORE_UNAVAILABLE:retry"); // nothing stale left to serve
  });

  it("entries are per organization and connection: another tenant never gets a cached value", async () => {
    const cached = new CachingSecretResolver(vault());
    await read(cached, undefined, ctx("org-a", "conn-1"));
    await read(cached, undefined, ctx("org-b", "conn-1"));
    await read(cached, undefined, ctx("org-a", "conn-2"));
    expect(seen).toHaveLength(3);
    cached.clear();
    await read(cached, undefined, ctx("org-a", "conn-1"));
    expect(seen).toHaveLength(4);
  });

  it("simulation: a 90-minute vault outage with sign-ins every 5 minutes — served for 60 minutes after the last read, then closed", async () => {
    let now = 0;
    const cached = new CachingSecretResolver(vault(), { now: () => now });
    await read(cached);                                   // t=0: last successful read
    handler = (_req, res) => json(res, 503, {});           // outage from t=0 to t=90 min
    const outcomes: string[] = [];
    for (let minute = 5; minute <= 90; minute += 5) { now = minute * 60_000; outcomes.push(await reason(read(cached))); }
    const served = outcomes.filter((o) => o === "OK").length;
    expect(served).toBe(11);                               // t=5..55 min (stale window is 60 minutes, exclusive)
    expect(outcomes.slice(11).every((o) => o === "SECRET_UNAVAILABLE:STORE_UNAVAILABLE:retry")).toBe(true);
  });
});

describe("Production never reads provider secrets from the environment", () => {
  it("refuses the environment store in Production, accepts a vault (cached or not), allows the environment elsewhere", () => {
    const production = { VERCEL_ENV: "production" };
    expect(() => assertSecretStoreAllowed(new EnvironmentSecretResolver(), production)).toThrow("PRODUCTION_SECRET_STORE_REQUIRED");
    expect(() => assertSecretStoreAllowed(new CachingSecretResolver(new EnvironmentSecretResolver()), production)).toThrow("PRODUCTION_SECRET_STORE_REQUIRED");
    expect(() => assertSecretStoreAllowed({}, { APP_ENV: "production" })).toThrow("PRODUCTION_SECRET_STORE_REQUIRED");
    expect(() => assertSecretStoreAllowed(new CachingSecretResolver(vault()), production)).not.toThrow();
    expect(() => assertSecretStoreAllowed(new EnvironmentSecretResolver(), { VERCEL_ENV: "preview" })).not.toThrow();
  });
});
