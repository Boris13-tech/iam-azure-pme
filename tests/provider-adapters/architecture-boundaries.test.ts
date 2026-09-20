import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repositoryRoot = path.resolve(__dirname, "../..");

const providerNeutralCore = [
  path.join(repositoryRoot, "lib/provider-adapters"),
  path.join(repositoryRoot, "lib/auth/authorization-engine.ts"),
  path.join(repositoryRoot, "lib/auth/entitlements-catalog.ts"),
];

const forbiddenImports = [
  /^@azure\//,
  /^@microsoft\//,
  /^@aws-sdk\//,
  /^googleapis(?:\/|$)/,
  /^ldapjs(?:\/|$)/,
  /^openid-client(?:\/|$)/,
  /^@prisma\/client$/,
  /^next(?:\/|$)/,
  /(?:^|\/)auth\/providers(?:\/|$)/,
  /(?:^|\/)graph(?:\.|\/|$)/,
  /(?:^|\/)implementations(?:\/|$)/,
];

describe("Phase 6A architecture boundaries", () => {
  it("keeps provider-neutral core free of provider SDKs and implementations", () => {
    const violations: string[] = [];
    for (const file of providerNeutralCore.flatMap(sourceFiles)) {
      const content = fs.readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(content)) {
        if (forbiddenImports.some((pattern) => pattern.test(specifier))) {
          violations.push(
            `${path.relative(repositoryRoot, file)} imports '${specifier}'`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps concrete provider code outside the Phase 6A contract barrel", () => {
    const barrel = fs.readFileSync(
      path.join(repositoryRoot, "lib/provider-adapters/index.ts"),
      "utf8",
    );
    expect(barrel).not.toMatch(/entra|microsoft|graph|luxia_local/i);
  });
});

function sourceFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) =>
      sourceFiles(path.join(target, entry.name)),
    )
    .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
}

function importSpecifiers(source: string): string[] {
  const matches = source.matchAll(
    /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g,
  );
  return Array.from(matches, (match) => match[1] ?? match[2] ?? match[3]);
}
