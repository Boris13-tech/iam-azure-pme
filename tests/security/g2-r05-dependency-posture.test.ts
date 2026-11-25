import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../..");

function parseSemver(version: string): [number, number, number] {
  const clean = version.replace(/^[^\d]*/, "").split("-")[0];
  const [maj, min, pat] = clean.split(".").map((n) => Number(n));
  return [maj || 0, min || 0, pat || 0];
}

function gte(actual: string, minimum: [number, number, number]): boolean {
  const [aMaj, aMin, aPat] = parseSemver(actual);
  const [mMaj, mMin, mPat] = minimum;
  if (aMaj !== mMaj) return aMaj > mMaj;
  if (aMin !== mMin) return aMin > mMin;
  return aPat >= mPat;
}

describe("G2-R05 (F-05): dependency security posture without unjustified overrides", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    overrides?: unknown;
    resolutions?: unknown;
  };
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };

  it("keeps package.json free of arbitrary overrides or resolutions", () => {
    expect(pkg.overrides).toBeUndefined();
    expect(pkg.resolutions).toBeUndefined();
  });

  it("enforces patched versions of next, @azure/msal-node, root postcss, and removes vulnerable transitive uuid", () => {
    const nextVersion = lock.packages["node_modules/next"]?.version ?? "";
    expect(gte(nextVersion, [15, 5, 29]), `next=${nextVersion}`).toBe(true);

    const msalVersion = lock.packages["node_modules/@azure/msal-node"]?.version ?? "";
    expect(gte(msalVersion, [7, 2, 3]), `@azure/msal-node=${msalVersion}`).toBe(true);

    // Transitive uuid (< 11.1.1, GHSA-w5hq-g745-h8pq) is completely eliminated from the dependency tree.
    const uuidEntries = Object.keys(lock.packages).filter((k) => k === "node_modules/uuid" || k.endsWith("/node_modules/uuid"));
    expect(uuidEntries).toEqual([]);

    const rootPostcss = lock.packages["node_modules/postcss"]?.version ?? "";
    expect(gte(rootPostcss, [8, 5, 23]), `postcss=${rootPostcss}`).toBe(true);

    const tsEstreeMinimatch =
      lock.packages["node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch"]?.version ??
      lock.packages["node_modules/minimatch"]?.version ??
      "";
    expect(tsEstreeMinimatch).not.toMatch(/^(7|8|9|10)\.|^11\.0\.0$/);
  });
});
