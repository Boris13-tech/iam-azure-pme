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
});
