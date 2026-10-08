import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("resource architecture boundaries", () => {
  it("keeps the new authority provider/legacy independent", () => {
    for (const file of ["lib/resources/authorization.ts", "lib/resources/service.ts"]) {
      const code = readFileSync(file, "utf8");
      expect(code).toContain("withTenantDb");
      expect(code).not.toMatch(/from .*legacy|from .*authorization-gateway|\.userRole\.|\.permission\.|\.auditLog\.|@azure|microsoft-graph/);
    }
  });
  it("forces RLS, composite FKs and no business seeds", () => {
    const sql = readFileSync("prisma/migrations/20261004120000_resource_governance_foundation/migration.sql", "utf8");
    for (const table of ["ResourceScope", "ResourceScopeMember"]) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain('FOREIGN KEY ("organizationId","tenantId","resourceId")');
    expect(sql).not.toMatch(/INSERT INTO|DROP TABLE|DELETE FROM|ALTER TABLE "(?:User|Role|Permission|AccessPolicy|AuditLog)"/);
  });
  it("HTTP never trusts a body-supplied subject or tenant", () => {
    const code = readFileSync("app/api/canonical/resource-governance/[...path]/route.ts", "utf8");
    expect(code).toContain("await requireAuth()");
    expect(code).toContain(".strict()");
    expect(code).toContain("service.checkAccess(auth");
    expect(code).toContain("mutationChangeId(request)");
  });
});
