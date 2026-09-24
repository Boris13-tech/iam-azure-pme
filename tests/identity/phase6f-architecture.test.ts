import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../.."); const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Phase 6F architecture boundaries", () => {
  it("defines proof as one-time evidence, never a reusable bearer token", () => {
    const source = read("lib/identity/offline-proof.ts");
    expect(source).toContain('tokenSemantics: "ONE_TIME_CHALLENGE_RESPONSE"');
    expect(source).toContain("consumeChallenge"); expect(source).toContain("reusableBearer: false");
    expect(source).not.toMatch(/accessToken|refreshToken|bearerToken/i);
  });
  it("keeps provider SDKs, Policy, Trust Graph and Trust Ledger outside continuity core", () => {
    for (const path of ["lib/identity/continuity.ts", "lib/identity/offline-proof.ts", "lib/identity/continuity-reconciliation.ts"])
      expect(read(path)).not.toMatch(/@azure|microsoft-graph|openid-client|trust[- ]?graph|trust[- ]?ledger|policy engine/i);
  });
  it("advances persisted credential security state on local revocation", () => {
    const source = read("lib/provider-adapters/implementations/luxia-local/prisma-local-identity-store.ts");
    expect(source.match(/stateVersion: \{ increment: 1 \}/g)).toHaveLength(2);
  });
  it("forces RLS on every continuity table", () => {
    const migration = read("prisma/migrations/20260923020000_phase6f_identity_continuity/migration.sql");
    for (const table of ["IdentityContinuityState", "OfflineIdentityChallenge", "IdentityAssuranceSnapshot", "IdentityContinuityEvent", "IdentityContinuityConflict"])
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    expect(migration).toContain("INTERVAL '5 minutes'"); expect(migration).toContain("INTERVAL '8 hours'");
  });
});
