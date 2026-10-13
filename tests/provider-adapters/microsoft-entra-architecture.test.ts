import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const implementationRoot = path.join(
  root,
  "lib/provider-adapters/implementations/microsoft-entra",
);
// The generic OIDC core (sovereign design, F1): OpenID Connect is a standard, not a Microsoft dependency.
const oidcCoreRoot = path.join(root, "lib/provider-adapters/implementations/oidc");
const allowedImplementationImporters = new Set([
  "lib/auth/providers/entra.ts",
  "lib/graph.ts",
]);

describe("Phase 6B Microsoft dependency boundary", () => {
  it("confines Microsoft SDKs to the Entra implementation, and openid-client to the generic OIDC core", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(path.join(root, "app")).concat(sourceFiles(path.join(root, "lib")))) {
      const relative = slash(path.relative(root, file));
      for (const specifier of imports(fs.readFileSync(file, "utf8"))) {
        if (["@azure/msal-node", "@microsoft/microsoft-graph-client"].includes(specifier) && !file.startsWith(implementationRoot))
          violations.push(`${relative} imports '${specifier}'`);
        if (specifier === "openid-client" && !file.startsWith(oidcCoreRoot))
          violations.push(`${relative} imports '${specifier}'`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the generic OIDC core vendor-neutral, and plain-HTTP discovery out of runtime code", () => {
    for (const file of sourceFiles(oidcCoreRoot)) {
      const content = fs.readFileSync(file, "utf8");
      expect(content, slash(path.relative(root, file))).not.toMatch(/microsoft|entra|azure|google|graph|\btid\b|\boid\b/i);
      expect(content).not.toMatch(/implementations\/(microsoft-entra|luxia-local|cloud-providers|enterprise-directory)/);
    }
    for (const file of sourceFiles(path.join(root, "app")).concat(sourceFiles(path.join(root, "lib"))))
      expect(fs.readFileSync(file, "utf8"), slash(path.relative(root, file))).not.toContain("allowInsecureRequests");
  });

  it("allows application code to reach the Entra implementation only through compatibility facades", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(path.join(root, "app")).concat(sourceFiles(path.join(root, "lib")))) {
      if (file.startsWith(implementationRoot)) continue;
      const relative = slash(path.relative(root, file));
      const content = fs.readFileSync(file, "utf8");
      if (
        content.includes("provider-adapters/implementations/microsoft-entra") &&
        !allowedImplementationImporters.has(relative)
      ) {
        violations.push(relative);
      }
    }
    expect(violations).toEqual([]);
  });
});

function sourceFiles(target: string): string[] {
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return child.endsWith(".ts") || child.endsWith(".tsx") ? [child] : [];
  });
}

function imports(source: string): string[] {
  return Array.from(
    source.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g),
    (match) => match[1],
  );
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}
