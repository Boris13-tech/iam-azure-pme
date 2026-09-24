import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
describe("Phase 6G architecture boundaries", () => {
  it("keeps portability provider-neutral and network-independent", () => {
    const source = ["lib/identity/portability.ts", "lib/identity/portability-import.ts", "lib/identity/encrypted-backup.ts",
      "lib/identity/sovereign-recovery.ts"].map(read).join("\n");
    expect(source).not.toMatch(/@azure|microsoft-graph|googleapis|aws-sdk|fetch\s*\(/);
    expect(source).not.toMatch(/plaintextPrivateKey|totpSeed|passwordHash/);
  });

  it("migrates additively with forced RLS and recovery invalidation", () => {
    const migration = read("prisma/migrations/20260923030000_phase6g_identity_portability_recovery/migration.sql");
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE)/i);
    expect((migration.match(/FORCE ROW LEVEL SECURITY/g) ?? [])).toHaveLength(5);
    const activation = read("lib/db/prisma-sovereign-recovery-store.ts");
    expect(activation).toContain("recoveryEpoch"); expect(activation).toContain("revokedAt"); expect(activation).toContain("consumedAt");
  });
});
