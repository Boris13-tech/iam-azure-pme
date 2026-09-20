import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const implementationRoot = path.join(
  root,
  "lib/provider-adapters/implementations/microsoft-entra",
);
const allowedImplementationImporters = new Set([
  "lib/auth/providers/entra.ts",
  "lib/graph.ts",
  "lib/jwt.ts",
]);

describe("Phase 6B Microsoft dependency boundary", () => {
  it("confines Microsoft and OIDC SDK imports to the Entra implementation", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(path.join(root, "app")).concat(sourceFiles(path.join(root, "lib")))) {
      const relative = slash(path.relative(root, file));
      const insideImplementation = file.startsWith(implementationRoot);
      for (const specifier of imports(fs.readFileSync(file, "utf8"))) {
        if (
          ["@azure/msal-node", "@microsoft/microsoft-graph-client", "openid-client"].includes(specifier) &&
          !insideImplementation
        ) {
          violations.push(`${relative} imports '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);
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
