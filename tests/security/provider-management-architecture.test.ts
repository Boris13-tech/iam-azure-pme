import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("Provider management authorization and persistence boundaries", () => {
  it("protects every management route with canonical entitlements", () => {
    for (const route of ["route.ts", "[id]/route.ts", "[id]/operations/route.ts", "[id]/collisions/[collisionId]/route.ts"]) {
      const source = readFileSync(`app/api/canonical/provider-management/${route}`, "utf8");
      expect(source).toContain('requireCanonicalAccess("providers",');
      if (source.includes("function POST") || source.includes("function PATCH")) {
        expect(source).toContain('requireCanonicalAccess("providers", "manage")');
        expect(source).toContain("mutationChangeId(request)");
      }
      expect(source).not.toContain("rawPrisma");
    }
  });
  it("forces RLS, composite tenant scope and dry-run zero mutations in SQL", () => {
    const sql = readFileSync("prisma/migrations/20261003000000_providers_management_v1/migration.sql", "utf8");
    expect(sql).toContain('ALTER TABLE "ProviderSyncRun" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('REFERENCES "ProviderConnectionTenantScope"("organizationId", "tenantId", "providerConnectionId")');
    expect(sql).toContain('"created" = 0 AND "updated" = 0 AND "disabled" = 0');
    for (const table of ["User", "Role", "Permission", "UserRole", "AccessPolicy", "AuditLog", "LegacyUserBridge"]) {
      expect(sql).not.toMatch(new RegExp(`(?:ALTER|UPDATE|INSERT|DELETE|DROP).*?"${table}"`, "i"));
    }
  });
  it("management never owns canonical identity or creates implicit account links", () => {
    const service = readFileSync("lib/provider-management/service.ts", "utf8");
    expect(service).not.toMatch(/(?:subject|identityAccount)\.(?:create|update|delete)/);
    expect(service).not.toMatch(/implementations|@azure|@microsoft/);
    expect(service).toContain("withTenantDb");
  });
});
