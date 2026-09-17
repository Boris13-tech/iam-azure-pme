import { adminPrisma } from "../helpers/admin-prisma";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { runAuthorizationReconciliation } from "../../lib/auth/reconciliation-service";
import { dualWriteUpdateUserRole, dualWriteUpdateRolePermissions } from "../../lib/auth/dual-write-service";
import { randomUUID } from "crypto";

// This is an integration test suite for dual-write data correctness.
// Requires PostgreSQL running.
describe("Phase 5E.1 - Authorization Cutover Readiness", () => {
  let orgId = "";
  let tenantId = "";
  let subjectId = "";
  let legacyUserId = "";
  let roleAId = "";
  let roleBId = "";

  beforeAll(async () => {
    try {
      await rawPrisma.$connect();
    } catch {
      console.warn("DB not reachable, skipping tests");
      return;
    }

    orgId = randomUUID();
    tenantId = randomUUID();
    
    // Create org & tenant
    await adminPrisma.organization.create({ data: { id: orgId, name: "Recon Org" } });
    await adminPrisma.tenant.create({ data: { id: tenantId, organizationId: orgId, name: "Recon Tenant" } });
    
    // Create legacy roles
    const roleA = await adminPrisma.role.create({ data: { name: "Role A " + randomUUID(), isCustom: true } });
    const roleB = await adminPrisma.role.create({ data: { name: "Role B " + randomUUID(), isCustom: true } });
    roleAId = roleA.id;
    roleBId = roleB.id;

    // Create legacy permissions
    const perm1 = await adminPrisma.permission.create({ data: { action: "read", resource: "users" } });
    const perm2 = await adminPrisma.permission.create({ data: { action: "create", resource: "users" } });

    await adminPrisma.rolePermission.createMany({
      data: [
        { roleId: roleAId, permissionId: perm1.id },
        { roleId: roleBId, permissionId: perm2.id }
      ]
    });

    // Create user & subject
    const user = await adminPrisma.user.create({ data: { email: `test-${randomUUID()}@luxia.fr`, name: "Recon User" } });
    legacyUserId = user.id;

    const subject = await adminPrisma.subject.create({
      data: {
        id: randomUUID(),
        organizationId: orgId,
        tenantId,
        name: "Recon Subject",
        type: "HUMAN"
      }
    });
    subjectId = subject.id;

    await adminPrisma.legacyUserBridge.create({
      data: {
        legacyUserId,
        subjectId,
        organizationId: orgId,
        status: "VALIDATED"
      }
    });
  });

  afterAll(async () => {
    try {
      await adminPrisma.organization.delete({ where: { id: orgId } }).catch(() => {});
      await adminPrisma.role.delete({ where: { id: roleAId } }).catch(() => {});
      await adminPrisma.role.delete({ where: { id: roleBId } }).catch(() => {});
      await adminPrisma.user.delete({ where: { id: legacyUserId } }).catch(() => {});
    } catch {}
  });

  it("should generate a clean reconciliation report for an empty user", async () => {
    if (!orgId) return; // Skip if no DB
    const report = await runAuthorizationReconciliation(orgId, tenantId);
    expect(report.missingNativeGrants).toBe(0);
    expect(report.unexpectedNativeGrants).toBe(0);
    expect(report.orphanLegacyRoleAssignments).toBe(0);
  });

  it("should dual-write role A and pass reconciliation", async () => {
    if (!orgId) return;
    const auth = { organizationId: orgId, tenantId: tenantId, subjectId: "admin", type: "HUMAN" } as any;
    
    // Assign Role A
    await dualWriteUpdateUserRole(auth, legacyUserId, roleAId);

    const report = await runAuthorizationReconciliation(orgId, tenantId);
    expect(report.missingNativeGrants).toBe(0);
    expect(report.unexpectedNativeGrants).toBe(0);
    expect(report.orphanLegacyRoleAssignments).toBe(0);
    
    // Should have 1 assignment active
    const assignments = await adminPrisma.assignment.findMany({ where: { subjectId, status: "ACTIVE" }});
    expect(assignments.length).toBe(1);
    expect(assignments[0].sourceRef).toBe(roleAId);
  });

  it("should revoke ghost grants when replacing Role A with Role B", async () => {
    if (!orgId) return;
    const auth = { organizationId: orgId, tenantId: tenantId, subjectId: "admin", type: "HUMAN" } as any;

    // Replace with Role B
    await dualWriteUpdateUserRole(auth, legacyUserId, roleBId);

    const report = await runAuthorizationReconciliation(orgId, tenantId);
    expect(report.missingNativeGrants).toBe(0);
    expect(report.unexpectedNativeGrants).toBe(0);
    expect(report.orphanLegacyRoleAssignments).toBe(0);

    // Active assignment should only be from Role B
    const active = await adminPrisma.assignment.findMany({ where: { subjectId, status: "ACTIVE" }, include: { entitlement: true }});
    expect(active.length).toBe(1);
    expect(active[0].sourceRef).toBe(roleBId);
    expect(active[0].entitlement.key).toBe("users.create");

    // Old assignment should be REVOKED
    const revoked = await adminPrisma.assignment.findMany({ where: { subjectId, status: "REVOKED" }});
    expect(revoked.length).toBeGreaterThanOrEqual(1);
    expect(revoked.some(r => r.sourceRef === roleAId)).toBe(true);
  });

  it("should reject global role permission mutation during Phase 5E/5F", async () => {
    if (!orgId) return;
    const auth = { organizationId: orgId, tenantId: tenantId, subjectId: "admin", type: "HUMAN" } as any;

    await expect(
      dualWriteUpdateRolePermissions(auth, roleBId, "Role B empty", "", [])
    ).rejects.toThrow(/Global role definitions are frozen/);



  });

  it("should handle deterministic reconciliation (running twice yields same result)", async () => {
    if (!orgId) return;
    const run1 = await runAuthorizationReconciliation(orgId, tenantId);
    const run2 = await runAuthorizationReconciliation(orgId, tenantId);
    expect(run1).toEqual(run2);
  });

  it("should handle concurrent role replacements without ghost grants", async () => {
    if (!orgId) return;
    const auth = { organizationId: orgId, tenantId: tenantId, subjectId: "admin", type: "HUMAN" } as any;

    // We simulate two parallel requests updating the user's role:
    // Request 1: User gets Role A
    // Request 2: User gets Role B
    await Promise.all([
      dualWriteUpdateUserRole(auth, legacyUserId, roleAId).catch(() => {}),
      dualWriteUpdateUserRole(auth, legacyUserId, roleBId).catch(() => {})
    ]);

    // The user should eventually have ONE of the roles.
    const finalRole = await adminPrisma.userRole.findFirst({ where: { userId: legacyUserId } });
    expect(finalRole).toBeDefined();

    // The reconciliation should STILL be perfectly clean.
    const report = await runAuthorizationReconciliation(orgId, tenantId);
    expect(report.missingNativeGrants).toBe(0);
    expect(report.unexpectedNativeGrants).toBe(0);
    expect(report.orphanLegacyRoleAssignments).toBe(0);
    expect(report.expiredRevokedInconsistencies).toBe(0);
    
    // The active assignments should perfectly match the winning role.
    const active = await adminPrisma.assignment.findMany({ where: { subjectId, status: "ACTIVE" }});
    expect(active.every(a => a.sourceRef === finalRole!.roleId)).toBe(true);
  });
});
