import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { GOVERNANCE_ADMIN_V2 } from "../../lib/resources/admin-bundle";

// First Admin / Break-glass v1, B1. Every runtime write that can end an administrator (subject
// lifecycle, identity account status, grant status or entitlement) is either guarded or reviewed here
// with the reason it cannot remove one. A new writer fails this test until someone reviews it.
const root = join(__dirname, "../..");
const writer = /\.(assignment|identityAccount|subject|entitlement)\.(update|updateMany|upsert|delete|deleteMany)\(/g;

const guarded: Record<string, { writers: number; guards: number; guard: string }> = {
  "lib/admin/canonical-administration.ts": { writers: 4, guards: 3, guard: "guardLastAdministrator(tx" },
  "lib/resources/service.ts": { writers: 4, guards: 3, guard: "preserveLastAdministrator(tx" },
  "lib/resources/access-reviews.ts": { writers: 1, guards: 1, guard: "preserveLastAdministrator(tx" },
  "lib/resources/admin-bundle.ts": { writers: 1, guards: 1, guard: "preserveLastAdministrator(tx" },
};
const reviewed: Record<string, { writers: number; reason: string }> = {
  "lib/auth/dual-write-service.ts": { writers: 1, reason: "revokes LEGACY_ROLE grants only, which never count as administrator" },
  "lib/onboarding/invitations.ts": { writers: 1, reason: "activates an accepted invitation (PROVISIONING to ACTIVE), never removes" },
};

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
const body = (source: string, name: string) => {
  const start = source.indexOf(`export async function ${name}(`);
  return source.slice(start, source.indexOf("\nexport ", start + 1));
};

describe("B1 last-administrator guard architecture", () => {
  it("every writer of subjects, accounts, grants or entitlements is guarded or reviewed", () => {
    const found = Object.fromEntries(["lib", "app"].flatMap(dir => sources(join(root, dir)))
      .map(path => [relative(root, path).replace(/\\/g, "/"), (readFileSync(path, "utf8").match(writer) ?? []).length] as const)
      .filter(([, count]) => count > 0));
    const expected = Object.fromEntries([...Object.entries(guarded), ...Object.entries(reviewed)].map(([file, entry]) => [file, entry.writers]));
    expect(found).toEqual(expected);
    for (const [file, entry] of Object.entries(guarded)) {
      expect(read(file).split(entry.guard).length - 1, file).toBe(entry.guards);
    }
  });

  it("takes the lock before reading, in the same transaction, for each direct removal", () => {
    const source = read("lib/admin/canonical-administration.ts");
    for (const name of ["updateSubject", "disableIdentityAccount", "revokeAssignment"]) {
      const fn = body(source, name);
      expect(fn, name).toContain("return withTenantDb(auth");
      expect(fn, name).toContain("guardLastAdministrator(tx, auth");
      expect(fn.indexOf("lockAdministrators(tx, auth)"), name).toBeGreaterThan(-1);
      expect(fn.indexOf("lockAdministrators(tx, auth)"), name).toBeLessThan(fn.indexOf("assertUnusedChangeId"));
    }
    const guard = read("lib/admin/last-administrator.ts");
    expect(guard).toContain("pg_advisory_xact_lock");
    expect(guard.indexOf("lockAdministrators(tx, scope)")).toBeLessThan(guard.indexOf("SAVEPOINT luxia_last_administrator"));
    expect(guard).toContain("ROLLBACK TO SAVEPOINT luxia_last_administrator");
    expect(guard).toContain('source: { not: "LEGACY_ROLE" }, validUntil: null');
  });

  it("resource-scoped paths cannot select a catalog grant such as assignments.manage", () => {
    const service = read("lib/resources/service.ts");
    for (const name of ["revokeAssignment", "updateAssignment", "revokeEntitlement"]) {
      const start = service.indexOf(`export function ${name}(`);
      expect(service.slice(start, service.indexOf("\nexport ", start + 1)), name).toMatch(/resourceScopeId: \{ not: null \}/);
    }
    expect(read("lib/resources/access-reviews.ts")).toMatch(/entitlement: \{ active: true, resourceScopeId: \{ not: null \} \}/);
    expect(GOVERNANCE_ADMIN_V2).not.toContain("assignments.manage");
  });
});
