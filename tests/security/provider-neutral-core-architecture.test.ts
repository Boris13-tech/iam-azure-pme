import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Sovereign design, rule R2 (docs/architecture/SOVEREIGN-PROVIDER-FEDERATION-LAYER-DESIGN.md): the core never names a
// provider. Provider code lives in lib/provider-adapters and lib/auth/providers. A ratchet: the files below still
// name one (sign-in and logout glue, the provider admin route, dashboard labels) and are rewritten in phases F2 and F4.
// The list may only shrink; any new file that names a provider fails here.
const VENDOR = /MICROSOFT_ENTRA|GOOGLE_WORKSPACE|microsoftonline|graph\.microsoft|accounts\.google/;
const STILL_PROVIDER_AWARE = new Set([
  "app/api/canonical/providers/route.ts",
  "app/auth/login/route.ts",
  "app/auth/logout/route.ts",
  "app/dashboard/layout.tsx",
  "app/dashboard/page.tsx",
  "app/dashboard/settings/my-security.tsx",
]);
const ADAPTER_ROOTS = ["lib/provider-adapters/", "lib/auth/providers/"];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("Provider-neutral core (rule R2)", () => {
  it("no file outside the adapters names a provider, except the known glue that later phases rewrite", () => {
    const naming = [...files("lib"), ...files("app")]
      .filter(file => !ADAPTER_ROOTS.some(root => file.startsWith(root)))
      .filter(file => VENDOR.test(readFileSync(join(file), "utf8")))
      .sort();
    expect(naming.filter(file => !STILL_PROVIDER_AWARE.has(file))).toEqual([]);
    // When a listed file stops naming a provider, remove it from the list.
    expect([...STILL_PROVIDER_AWARE].filter(file => !naming.includes(file))).toEqual([]);
  });

  it("the sign-in resolver resolves connections through the adapter layer's list, never by provider name", () => {
    const source = readFileSync("lib/auth/organization-login.ts", "utf8");
    expect(source).toContain("FEDERATED_SIGN_IN_PROVIDER_TYPES");
    expect(source).not.toMatch(VENDOR);
  });
});
