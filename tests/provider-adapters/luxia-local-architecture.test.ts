import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const implementation = join(root, "lib/provider-adapters/implementations/luxia-local");

describe("Phase 6C local-provider boundaries", () => {
  it("has no network, cloud-provider SDK, or application-domain dependency", () => {
    const violations: string[] = [];
    for (const file of files(implementation)) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of ["@azure/", "@microsoft/", "openid-client", "isomorphic-fetch", "axios", "lib/auth/"])
        if (source.includes(forbidden)) violations.push(`${relative(root, file)}: ${forbidden}`);
    }
    expect(violations).toEqual([]);
  });

  it("adds RLS with USING and WITH CHECK for every local table", () => {
    const migration = readFileSync(join(root, "prisma/migrations/20260921000000_phase6c_luxia_local/migration.sql"), "utf8");
    for (const table of ["LocalIdentity", "LocalAuthenticator", "LocalAuthChallenge", "LocalRecoveryCode"]) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect((migration.match(/CREATE POLICY/g) ?? [])).toHaveLength(4);
    expect((migration.match(/WITH CHECK/g) ?? [])).toHaveLength(4);
  });

  it("stores no password, TOTP value, biometric template, or generic credential metadata", () => {
    const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
    const local = schema.slice(schema.indexOf("model LocalIdentity"), schema.indexOf("enum ResourceType")).replace(/^\/\/\/.*$/gm, "");
    expect(local).not.toMatch(/password|totpSecret|biometric|metadata\s+Json/i);
    expect(local).toContain("secretRef");
  });
});

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => { const item = join(directory, name); return statSync(item).isDirectory() ? files(item) : item.endsWith(".ts") ? [item] : []; });
}
