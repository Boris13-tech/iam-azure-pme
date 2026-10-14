import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// F3 (docs/architecture/F3-SECRET-STORE-DESIGN.md): static guarantees of the secret-store layer.
const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return /\.(ts|tsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}
const runtime = [...files("lib"), ...files("app")];
const STORES = "lib/provider-adapters/infrastructure/secret-stores/";

describe("Secret-store architecture (F3)", () => {
  it("no vault or identity SDK: the vault is reached through its REST API, so replacing the store never touches the core", () => {
    // @azure/msal-node stays where F1 confined it (the Microsoft Graph client of the Entra adapter); no vault SDK.
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).filter(name => /^@azure\/(keyvault|identity)/.test(name))).toEqual([]);
    expect(runtime.filter(file => /from ["']@azure\/(keyvault|identity)/.test(read(file)))).toEqual([]);
    expect(files(STORES.slice(0, -1)).filter(file => /from ["']@azure\//.test(read(file)))).toEqual([]);
  });

  it("vault and token endpoints are named only inside the secret-store adapters; the test hooks are never used by the application", () => {
    expect(runtime.filter(file => /vault\.azure\.net/.test(read(file)) && !file.startsWith(STORES))).toEqual([]);
    expect(runtime.filter(file => /\b(vaultUrl|authorityUrl)\s*:/.test(read(file)) && !file.startsWith(STORES))).toEqual([]);
  });

  it("the core depends on the SecretResolver port only, never on a concrete store", () => {
    const core = runtime.filter(file => !file.startsWith("lib/provider-adapters/") && !file.startsWith("lib/auth/providers/"));
    expect(core.filter(file => /secret-stores|AzureKeyVaultSecretResolver|FederatedWorkloadTokenProvider/.test(read(file)))).toEqual([]);
  });

  it("ratchet: the environment store is built only in the two current composition roots, which F3 rewires to a vault", () => {
    const builders = runtime.filter(file => /new EnvironmentSecretResolver\(/.test(read(file))).sort();
    expect(builders).toEqual(["lib/auth/providers/luxia-local.ts", "lib/provider-adapters/implementations/microsoft-entra/runtime.ts"]);
    expect(read("lib/provider-adapters/infrastructure/environment-secret-resolver.ts")).toContain(`readonly kind = "environment";`);
    expect(read(`${STORES}runtime-guard.ts`)).toContain(`throw new Error("PRODUCTION_SECRET_STORE_REQUIRED")`);
  });
});
