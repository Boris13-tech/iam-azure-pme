const fs = require('fs');
let f = 'tests/security/dual-write-ghost-grants.test.ts';
let c = fs.readFileSync(f, 'utf8');

c = c.replace(
  'it("should dynamically revoke assignments when role permissions are removed", async () => {',
  'it("should reject global role permission mutation during Phase 5E/5F", async () => {'
);
c = c.replace(
  '    // Update Role B to have NO permissions\n    await dualWriteUpdateRolePermissions(auth, roleBId, "Role B empty", "", []);',
  '    await expect(\n      dualWriteUpdateRolePermissions(auth, roleBId, "Role B empty", "", [])\n    ).rejects.toThrow(/Global role definitions are frozen/);\n'
);
c = c.replace(
  '    const report = await runAuthorizationReconciliation(orgId, tenantId);\n    expect(report.missingNativeGrants).toBe(0);\n    expect(report.unexpectedNativeGrants).toBe(0);\n    expect(report.orphanLegacyRoleAssignments).toBe(0);\n    expect(report.expectedNativeGrants).toBe(0);\n    expect(report.nativeActiveGrants).toBe(0);\n\n    // Everything should be revoked\n    const active = await adminPrisma.assignment.findMany({ where: { subjectId, status: "ACTIVE" }});\n    expect(active.length).toBe(0);',
  ''
);

fs.writeFileSync(f, c);
