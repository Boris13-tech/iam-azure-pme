import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("static SoD security boundaries", () => {
  it("contains no provider or legacy authority", () => {
    for (const path of ["lib/resources/sod.ts", "lib/resources/sod-service.ts"]) {
      expect(readFileSync(path, "utf8")).not.toMatch(/\.userRole\.|\.permission\.|\.auditLog\.|from .*legacy|from .*authorization-gateway|@azure|microsoft-graph/);
    }
  });
  it("RLS and scoped foreign keys with non-bypass database backstop", () => {
    const sql = readFileSync("prisma/migrations/20261004160000_static_sod_v1/migration.sql", "utf8");
    for (const model of ["SoDPolicy", "SoDRule"]) {
      expect(sql).toContain(`ALTER TABLE "${model}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${model}" FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain('FOREIGN KEY ("organizationId","tenantId","entitlementAId")');
    expect(sql).toContain('FOREIGN KEY ("organizationId","tenantId","entitlementBId")');
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).not.toMatch(/SECURITY DEFINER|BYPASSRLS|INSERT INTO|DROP TABLE|DELETE FROM/);
  });
  it("enforces before assignment write and emits a distinct committed denial", () => {
    const service = readFileSync("lib/resources/service.ts", "utf8");
    const grant = service.slice(service.indexOf("export function grantAssignment"), service.indexOf("export function revokeAssignment"));
    expect(grant.indexOf("await enforceSoD")).toBeLessThan(grant.indexOf("tx.assignment.create"));
    expect(service).toContain('"ASSIGNMENT.DENIED.SOD"');
    expect(service).toContain('if ("error" in outcome) throw outcome.error');
    expect(service).toContain("pg_advisory_xact_lock");
  });
});
