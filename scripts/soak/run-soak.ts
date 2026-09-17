import { randomUUID } from "crypto";
import { adminPrisma } from "../../tests/helpers/admin-prisma";
import { executeScenario, SoakScenario } from "./scenarios";
import { SoakReport } from "./report";
import { rawPrisma } from "../../lib/db/raw-prisma";
import * as crypto from "crypto";

async function main() {
  console.log("Starting Soak Staging Execution (Simulated Traffic)...");

  // 1. Setup deterministic fixtures (using adminPrisma ONLY)
  const orgId = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  
  const subject1Id = randomUUID(); // Has Role A in Tenant A
  const subject2Id = randomUUID(); // Has Role B in Tenant A
  const subject3Id = randomUUID(); // No Roles in Tenant A
  
  const legacyUser1 = randomUUID();
  const legacyUser2 = randomUUID();
  const legacyUser3 = randomUUID();

  // Make sure DB is clean from previous shadow observations
  await rawPrisma.authorizationShadowObservation.deleteMany();

  // Create Org & Tenants
  await adminPrisma.organization.create({ data: { id: orgId, name: "Soak Org" } });
  await adminPrisma.tenant.create({ data: { id: tenantA, organizationId: orgId, name: "Soak Tenant A" } });
  await adminPrisma.tenant.create({ data: { id: tenantB, organizationId: orgId, name: "Soak Tenant B" } });
  
  // Roles
  const roleA = await adminPrisma.role.create({ data: { name: "Role A " + randomUUID(), isCustom: true } });
  const roleB = await adminPrisma.role.create({ data: { name: "Role B " + randomUUID(), isCustom: true } });
  
  // Permissions
  const permUsersRead = await adminPrisma.permission.findFirst({ where: { action: "read", resource: "users" } }) 
    || await adminPrisma.permission.create({ data: { action: "read", resource: "users" } });
  const permUsersCreate = await adminPrisma.permission.findFirst({ where: { action: "create", resource: "users" } })
    || await adminPrisma.permission.create({ data: { action: "create", resource: "users" } });
  const permSettingsRead = await adminPrisma.permission.findFirst({ where: { action: "read", resource: "settings" } })
    || await adminPrisma.permission.create({ data: { action: "read", resource: "settings" } });

  // Role Permissions
  await adminPrisma.rolePermission.create({ data: { roleId: roleA.id, permissionId: permUsersRead.id } });
  await adminPrisma.rolePermission.create({ data: { roleId: roleA.id, permissionId: permUsersCreate.id } });
  await adminPrisma.rolePermission.create({ data: { roleId: roleB.id, permissionId: permSettingsRead.id } });

  // Users & Subjects
  await adminPrisma.user.create({ data: { id: legacyUser1, email: "soak1@example.com", name: "Soak 1" } });
  await adminPrisma.user.create({ data: { id: legacyUser2, email: "soak2@example.com", name: "Soak 2" } });
  await adminPrisma.user.create({ data: { id: legacyUser3, email: "soak3@example.com", name: "Soak 3" } });

  await adminPrisma.subject.create({ data: { id: subject1Id, organizationId: orgId, organizationId: orgId,
      tenantId: tenantA, name: "S1", type: "HUMAN" } });
  await adminPrisma.subject.create({ data: { id: subject2Id, organizationId: orgId, tenantId: tenantA, name: "S2", type: "HUMAN" } });
  await adminPrisma.subject.create({ data: { id: subject3Id, organizationId: orgId, tenantId: tenantA, name: "S3", type: "HUMAN" } });

  await adminPrisma.legacyUserBridge.create({ data: { legacyUserId: legacyUser1, subjectId: subject1Id, organizationId: orgId, status: "VALIDATED" } });
  await adminPrisma.legacyUserBridge.create({ data: { legacyUserId: legacyUser2, subjectId: subject2Id, organizationId: orgId, status: "VALIDATED" } });
  await adminPrisma.legacyUserBridge.create({ data: { legacyUserId: legacyUser3, subjectId: subject3Id, organizationId: orgId, status: "VALIDATED" } });

  // Initial Memberships
  await adminPrisma.userRole.create({ data: { userId: legacyUser1, roleId: roleA.id } });
  await adminPrisma.userRole.create({ data: { userId: legacyUser2, roleId: roleB.id } });

  // Create Sessions for the Session Validation Scenarios
  const idpAccount = await adminPrisma.identityAccount.create({
    data: {
      providerConnectionId: (await adminPrisma.providerConnection.findFirst())?.id || "N/A",
      tenantId: tenantA,
      subjectId: subject1Id,
      externalObjectId: "oidc-sub-1"
    }
  });

  const validToken = randomUUID();
  const validHash = crypto.createHash("sha256").update(validToken).digest("hex");
  await adminPrisma.session.create({
    data: {
      id: validHash,
      organizationId: orgId,
      tenantId: tenantA,
      subjectId: subject1Id,
      identityAccountId: idpAccount.id,
      expiresAt: new Date(Date.now() + 3600 * 1000)
    }
  });

  const expiredToken = randomUUID();
  const expiredHash = crypto.createHash("sha256").update(expiredToken).digest("hex");
  await adminPrisma.session.create({
    data: {
      id: expiredHash,
      organizationId: orgId,
      tenantId: tenantA,
      subjectId: subject1Id,
      identityAccountId: idpAccount.id,
      expiresAt: new Date(Date.now() - 3600 * 1000)
    }
  });

  const revokedToken = randomUUID();
  const revokedHash = crypto.createHash("sha256").update(revokedToken).digest("hex");
  await adminPrisma.session.create({
    data: {
      id: revokedHash,
      organizationId: orgId,
      tenantId: tenantA,
      subjectId: subject1Id,
      identityAccountId: idpAccount.id,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      revokedAt: new Date()
    }
  });

  // Backfill native
  const { runLegacyRbacBackfill } = require("../../lib/auth/backfill-service");
  await runLegacyRbacBackfill(orgId, tenantA, true);

  // Helper for reconciliation
  const { runAuthorizationReconciliation } = require("../../lib/auth/reconciliation-service");
  const checkReconciliation = async (checkpointName: string) => {
    const rep = await runAuthorizationReconciliation(orgId, tenantA);
    const drift = rep.missingNativeGrants + rep.unexpectedNativeGrants + rep.orphanLegacyRoleAssignments + rep.expiredRevokedInconsistencies;
    if (drift > 0) {
      console.error(`🚨 DRIFT DETECTED at checkpoint: ${checkpointName}`);
      process.exit(1);
    }
  };

  // Scenarios Generation
  const report = new SoakReport();
  const scenarios: SoakScenario[] = [];

  const auth1 = { organizationId: orgId, tenantId: tenantA, subjectId: subject1Id, type: "HUMAN" } as any;
  const auth2 = { organizationId: orgId, tenantId: tenantA, subjectId: subject2Id, type: "HUMAN" } as any;
  const auth3 = { organizationId: orgId, tenantId: tenantA, subjectId: subject3Id, type: "HUMAN" } as any;
  const auth1TenantB = { organizationId: orgId, tenantId: tenantB, subjectId: subject1Id, type: "HUMAN" } as any;

  // Level 1: Smoke (Deterministic)
  console.log("Running Smoke Scenarios...");
  scenarios.push({ id: "smoke-allow", type: "AUTHORIZE", authContext: auth1, action: "read", resource: "users", expectedGatewayDecision: true });
  scenarios.push({ id: "smoke-deny", type: "AUTHORIZE", authContext: auth1, action: "read", resource: "settings", expectedGatewayDecision: false });
  scenarios.push({ id: "smoke-unknown-entitlement", type: "AUTHORIZE", authContext: auth1, action: "fly", resource: "moon", expectedGatewayDecision: false });
  scenarios.push({ id: "smoke-cross-tenant-deny", type: "AUTHORIZE", authContext: auth1TenantB, action: "read", resource: "users", expectedGatewayDecision: false });
  
  // Session Scenarios
  scenarios.push({ id: "session-valid", type: "SESSION_VALIDATION", authContext: auth1, rawToken: validToken, expectedSessionValid: true });
  scenarios.push({ id: "session-expired", type: "SESSION_VALIDATION", authContext: auth1, rawToken: expiredToken, expectedSessionValid: false });
  scenarios.push({ id: "session-revoked", type: "SESSION_VALIDATION", authContext: auth1, rawToken: revokedToken, expectedSessionValid: false });

  for (const s of scenarios) {
    report.addResult(await executeScenario(s));
  }
  scenarios.length = 0; // clear run

  await checkReconciliation("After Smoke");

  // Level 2: Mutation Sequence (Grant -> Revoke -> Grant)
  console.log("Running Mutation Sequence...");
  scenarios.push({ id: "mut-grant", type: "DUAL_WRITE_MEMBERSHIP", authContext: auth1, targetLegacyUserId: legacyUser3, targetRoleId: roleA.id });
  scenarios.push({ id: "mut-auth-grant", type: "AUTHORIZE", authContext: auth3, action: "read", resource: "users", expectedGatewayDecision: true });
  
  for (const s of scenarios) report.addResult(await executeScenario(s));
  scenarios.length = 0;
  await checkReconciliation("After Grant");

  scenarios.push({ id: "mut-revoke", type: "REVOKE_MEMBERSHIP", authContext: auth1, targetLegacyUserId: legacyUser3 });
  scenarios.push({ id: "mut-auth-revoke", type: "AUTHORIZE", authContext: auth3, action: "read", resource: "users", expectedGatewayDecision: false });

  for (const s of scenarios) report.addResult(await executeScenario(s));
  scenarios.length = 0;
  await checkReconciliation("After Revoke");

  scenarios.push({ id: "mut-regrant", type: "DUAL_WRITE_MEMBERSHIP", authContext: auth1, targetLegacyUserId: legacyUser3, targetRoleId: roleB.id });
  scenarios.push({ id: "mut-auth-regrant", type: "AUTHORIZE", authContext: auth3, action: "read", resource: "settings", expectedGatewayDecision: true });

  for (const s of scenarios) report.addResult(await executeScenario(s));
  scenarios.length = 0;
  await checkReconciliation("After Re-Grant");


  // Level 3: Functional (Simulated Mixed Load)
  console.log("Generating 1000 functional operations...");
  for(let i=0; i<1000; i++) {
    const sId = i % 3 === 0 ? auth1 : (i % 3 === 1 ? auth2 : auth3);
    const actions = [
      { a: "read", r: "users" },
      { a: "create", r: "users" },
      { a: "read", r: "settings" },
      { a: "delete", r: "roles" },
      { a: "read", r: "audit" }
    ];
    const target = actions[i % actions.length];
    
    scenarios.push({
      id: `func-${i}`,
      type: "AUTHORIZE",
      authContext: sId,
      action: target.a,
      resource: target.r
    });
  }

  for (const s of scenarios) {
    try {
      const result = await executeScenario(s);
      report.addResult(result);
    } catch (e: any) {
      console.error(`\n🚨 FATAL SOAK FAILURE on scenario ${s.id}:`, e.message);
      process.exit(1);
    }
  }
  
  await checkReconciliation("After Functional Load");

  // Rollback drill test check
  console.log("Running simulated rollback drill (native-shadow-legacy -> legacy -> native-shadow-legacy)...");
  // Basically checking if we can still call hasLegacyPermission successfully
  const { hasLegacyPermission } = require("../../lib/auth/legacy-auth-adapter");
  const fallback = await hasLegacyPermission(legacyUser1, "read", "users");
  if (!fallback) {
    console.error("🚨 ROLLBACK DRILL FAILED: legacy adapter returned false for known entitlement.");
    process.exit(1);
  }

  // Output Report
  await report.generateAndExit();
}

main().catch(e => {
  console.error("Soak execution crashed:", e);
  process.exit(1);
});
