import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// F4, slice S1 (finding F4-S1): no request to an identity provider bypasses the SSRF-guarded transport.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const production = [...files("app"), ...files("lib")];
const GATEWAY = join("lib", "provider-adapters", "implementations", "oidc", "gateway.ts");
const GUARD = join("lib", "provider-adapters", "infrastructure", "outbound", "guarded-fetch.ts");

describe("identity providers are reached only through the SSRF-guarded transport", () => {
  it("only the OIDC core talks to openid-client, and it uses the guard by default for discovery, keys and token", () => {
    expect(production.filter((file) => /from ["']openid-client["']/.test(read(file)))).toEqual([GATEWAY]);
    const gateway = read(GATEWAY);
    expect(gateway).toContain("private readonly outboundFetch: typeof fetch = createGuardedFetch(),");
    expect(gateway).toContain("this.discoveryOptions ?? { [client.customFetch]: guarded }");
    expect(gateway).toContain("if (!this.discoveryOptions) oidcConfig[client.customFetch] = guarded;");
  });

  it("production code builds the OIDC core with the secret resolver only: never test discovery options, never another fetch", () => {
    const builds = production.flatMap((file) => [...read(file).matchAll(/new OpenIdClientOidcGateway\(([^)]*)\)/g)].map((m) => `${file}: ${m[1].trim()}`));
    expect(builds.length).toBeGreaterThan(0);
    for (const build of builds) expect(build).toMatch(/: \w+$/);
  });

  it("the default transport checks every address before connecting, pins it, and refuses redirects, other ports and schemes", () => {
    const guard = read(GUARD);
    expect(guard).toContain(`if (url.protocol !== "https:") throw new OutboundRefusedError("OUTBOUND_SCHEME");`);
    expect(guard).toContain(`if (url.port !== "" && url.port !== "443") throw new OutboundRefusedError("OUTBOUND_PORT");`);
    expect(guard).toContain(`if (!addresses.every(isPublicAddress)) throw new OutboundRefusedError("OUTBOUND_PRIVATE_ADDRESS");`);
    expect(guard).toContain(`if (response.status >= 300 && response.status < 400) throw new OutboundRefusedError("OUTBOUND_REDIRECT");`);
    // The connection goes to the validated address (Node's lookup replaced), on port 443, with no shared agent.
    expect(guard).toMatch(/lookup: pinnedLookup as never,/);
    expect(guard).toMatch(/port: 443,/);
    expect(guard).toMatch(/agent: false,/);
    expect(guard).not.toMatch(/rejectUnauthorized/);
  });

  it("S3: the connection test reaches the IdP through the guard, and only after the permission check", () => {
    const probe = read(join("lib", "provider-adapters", "implementations", "oidc", "probe.ts"));
    expect(probe).toContain("const fetcher = options.fetch ?? createGuardedFetch(");
    expect(probe).toContain("await checkOutboundTarget(endpoints.authorization_endpoint, options.resolve);");
    expect(probe).not.toMatch(/\bawait fetch\(/);
    const service = read(join("lib", "admin", "provider-connection-test.ts"));
    const permission = service.indexOf(`await requireNative(tx, auth, "providers.manage");`);
    const probeCall = service.indexOf("await dependencies.probe(");
    const journaled = service.indexOf(`return operation(auth, changeId, "PROVIDER.CONNECTION.TEST", "providers.manage", async (tx) => {`);
    expect(permission).toBeGreaterThan(0);
    expect(probeCall).toBeGreaterThan(permission);
    // The network call is not inside the journaled transaction (no governance lock held while an outside host answers).
    expect(journaled).toBeGreaterThan(probeCall);
    expect(service).toContain(`throw new CanonicalAdminError("CONNECTION_CONFIGURATION_CHANGED", 409);`);
  });
});
