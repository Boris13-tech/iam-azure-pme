import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const migration = fs.readFileSync(path.join(root, "prisma/migrations/20261001000000_canonical_administration_v1/migration.sql"), "utf8");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const service = fs.readFileSync(path.join(root, "lib/admin/canonical-administration.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(
  path.join(root, "docs/operations/canonical-administration-v1-bundle.json"),
  "utf8",
));
const dryRun = fs.readFileSync(path.join(root, "scripts/canonical-admin-v1-dry-run.sql"), "utf8");

describe("Canonical Administration v1 architecture", () => {
  it("uses a dedicated tenant-scoped audit model rather than legacy AuditLog", () => {
    expect(schema).toContain("model CanonicalAdminAuditEvent");
    expect(schema).toMatch(/actor\s+Subject\s+@relation\("CanonicalAdminActor"/);
    expect(migration).toContain('ALTER TABLE "CanonicalAdminAuditEvent" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY "canonical_admin_audit_tenant_isolation"');
    expect(service).not.toMatch(/auditLog|legacyUser|UserRole/);
  });

  it("does not mutate legacy authorization tables in the migration", () => {
    for (const table of ["Role", "Permission", "UserRole", "AccessPolicy", "AuditLog"]) {
      expect(migration).not.toMatch(new RegExp(`(?:ALTER|DROP|INSERT|UPDATE|DELETE).*?"${table}"`, "i"));
    }
  });

  it("enforces RLS for provider-to-tenant visibility", () => {
    expect(schema).toContain("model ProviderConnectionTenantScope");
    expect(migration).toContain('ALTER TABLE "ProviderConnectionTenantScope" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY "provider_connection_scope_tenant_isolation"');
  });

  it("keeps every canonical route behind an explicit entitlement", () => {
    const expected = new Map([
      ["audit/route.ts", ['requireCanonicalAccess("audit", "read")']],
      ["subjects/route.ts", ['requireCanonicalAccess("subjects", "read")', 'requireCanonicalAccess("subjects", "create")']],
      ["subjects/[id]/route.ts", ['requireCanonicalAccess("subjects", "update")']],
      ["identity-accounts/route.ts", ['requireCanonicalAccess("identity_accounts", "read")', 'requireCanonicalAccess("identity_accounts", "link")']],
      ["identity-accounts/[id]/disable/route.ts", ['requireCanonicalAccess("identity_accounts", "disable")']],
      ["assignments/route.ts", ['requireCanonicalAccess("assignments", "read")', 'requireCanonicalAccess("assignments", "manage")']],
      ["assignments/[id]/revoke/route.ts", ['requireCanonicalAccess("assignments", "manage")']],
      ["sessions/route.ts", ['requireCanonicalAccess("sessions", "read")']],
      ["sessions/[id]/revoke/route.ts", ['requireCanonicalAccess("sessions", "revoke")']],
      ["providers/route.ts", ['requireCanonicalAccess("providers", "read")', 'requireCanonicalAccess("providers", "manage")']],
      ["providers/[id]/route.ts", ['requireCanonicalAccess("providers", "manage")']],
      ["resources/route.ts", ['requireCanonicalAccess("resources", "read")', 'requireCanonicalAccess("resources", "manage")']],
      ["resources/[id]/route.ts", ['requireCanonicalAccess("resources", "manage")']],
    ]);
    for (const [relative, checks] of expected) {
      const content = fs.readFileSync(path.join(root, "app/api/canonical", relative), "utf8");
      for (const check of checks) expect(content).toContain(check);
      expect(content).not.toContain("rawPrisma");
    }
  });

  it("routes all canonical data operations through withTenantDb", () => {
    expect(service).toContain('import { withTenantDb } from "../db/scoped-client"');
    const exportedOperations = [...service.matchAll(/export async function (\w+)/g)].map((match) => match[1]);
    expect(exportedOperations.length).toBeGreaterThanOrEqual(15);
    expect((service.match(/return withTenantDb\(auth/g) ?? []).length).toBe(exportedOperations.length);
  });

  it("keeps the Production bundle deterministic and unapplied", () => {
    expect(manifest.status).toBe("PLANNED_NOT_APPLIED");
    expect(manifest.role).toEqual({
      key: "LUXIA_ORG_ADMIN",
      version: 1,
      sourceRef: "native-role:LUXIA_ORG_ADMIN:v1",
    });
    expect(manifest.grants).toHaveLength(15);
    expect(new Set(manifest.grants.map((grant: { key: string }) => grant.key)).size).toBe(15);
    expect(new Set(manifest.grants.flatMap((grant: { entitlementId: string; assignmentId: string }) => [
      grant.entitlementId,
      grant.assignmentId,
    ])).size).toBe(30);
  });

  it("keeps the supplied dry-run strictly read-only", () => {
    const withoutComments = dryRun.replace(/--.*$/gm, "");
    expect(withoutComments).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|CALL|DO)\b/im);
    expect(withoutComments).toMatch(/^\s*WITH\s+planned/i);
    expect(withoutComments).toContain("SELECT");
  });
});
