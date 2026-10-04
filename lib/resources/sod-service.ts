import type { AuthContext } from "../auth/authorization-engine";
import { CanonicalAdminError } from "../admin/canonical-administration";
import { operation } from "./service";
import { evaluateSoD } from "./sod";
import type { Prisma } from "@prisma/client";
const context = (a: AuthContext) => ({ organizationId: a.organizationId, tenantId: a.tenantId });

/** Activating a rule/policy must not legalize an already conflicting state. */
async function assertNoExistingConflicts(tx: Prisma.TransactionClient, auth: AuthContext) {
  const rows = await tx.assignment.findMany({ where: { ...context(auth), status: "ACTIVE", source: { not: "LEGACY_ROLE" },
    entitlement: { active: true, resourceScopeId: { not: null } }, OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] }, include: { entitlement: true, subject: true } });
  for (const row of rows) {
    const decision = await evaluateSoD(tx, { ...context(auth), subjectId: row.subjectId, entitlementId: row.entitlementId,
      scope: row.entitlement.resourceScopeId!, assignmentOperation: "MODIFY", excludeAssignmentId: row.id,
      validFrom: row.validFrom && row.validFrom > new Date() ? row.validFrom : new Date(), validUntil: row.validUntil ?? undefined }, true);
    if (decision.decision === "DENY") throw new CanonicalAdminError("SOD_CONFLICT", 409);
  }
}
export function listSoDPolicies(auth: AuthContext, changeId: string) {
  return operation(auth, changeId, "SOD.POLICY.READ", "sod.read", async tx => ({ value:
    await tx.soDPolicy.findMany({ where: context(auth), include: { rules: true, scope: true }, orderBy: { id: "asc" }, take: 100 }) }));
}
export function readSoDPolicy(auth: AuthContext, id: string, changeId: string) {
  return operation(auth, changeId, "SOD.POLICY.READ", "sod.read", async tx => {
    const value = await tx.soDPolicy.findFirst({ where: { ...context(auth), id }, include: { rules: true, scope: true } });
    if (!value) throw new CanonicalAdminError("NOT_FOUND", 404);
    return { value };
  });
}
export function createSoDPolicy(auth: AuthContext, input: { key: string; scopeId: string }, changeId: string) {
  return operation(auth, changeId, "SOD.POLICY.CREATE", "sod.manage", async tx => {
    if (!await tx.resourceScope.findFirst({ where: { ...context(auth), id: input.scopeId, active: true } })) throw new CanonicalAdminError("NOT_FOUND", 404);
    const value = await tx.soDPolicy.create({ data: { ...context(auth), ...input, status: "DISABLED" } });
    return { value, metadata: { policyId: value.id, scopeId: value.scopeId } };
  });
}
export function setSoDPolicyStatus(auth: AuthContext, id: string, status: "ACTIVE" | "DISABLED", changeId: string) {
  return operation(auth, changeId, "SOD.POLICY.UPDATE", "sod.manage", async tx => {
    const row = await tx.soDPolicy.findFirst({ where: { ...context(auth), id } });
    if (!row) throw new CanonicalAdminError("NOT_FOUND", 404);
    // Savepoint preserves DENY audit while rolling back a rejected policy activation.
    await tx.$executeRawUnsafe('SAVEPOINT sod_activation');
    const value = await tx.soDPolicy.update({ where: { organizationId_tenantId_id: { ...context(auth), id } }, data: { status } });
    try { if (status === "ACTIVE") await assertNoExistingConflicts(tx, auth); }
    catch (error) { await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sod_activation'); throw error; }
    return { value, metadata: { policyId: id, status } };
  });
}
export function createSoDRule(auth: AuthContext, policyId: string, input: { entitlementAId: string; entitlementBId: string }, changeId: string) {
  return operation(auth, changeId, "SOD.RULE.CREATE", "sod.manage", async tx => {
    if (!await tx.soDPolicy.findFirst({ where: { ...context(auth), id: policyId } })) throw new CanonicalAdminError("NOT_FOUND", 404);
    const ids = [input.entitlementAId, input.entitlementBId].sort();
    if (ids[0] === ids[1]) throw new CanonicalAdminError("INVALID_RULE", 400);
    if (await tx.entitlement.count({ where: { ...context(auth), id: { in: ids }, active: true, resourceScopeId: { not: null } } }) !== 2) throw new CanonicalAdminError("NOT_FOUND", 404);
    if (await tx.soDRule.findFirst({ where: { ...context(auth), policyId, entitlementAId: ids[0], entitlementBId: ids[1] } })) throw new CanonicalAdminError("RULE_ALREADY_EXISTS", 409);
    await tx.$executeRawUnsafe('SAVEPOINT sod_rule');
    const value = await tx.soDRule.create({ data: { ...context(auth), policyId, entitlementAId: ids[0], entitlementBId: ids[1] } });
    try { await assertNoExistingConflicts(tx, auth); }
    catch (error) { await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sod_rule'); throw error; }
    return { value, metadata: { policyId, ruleId: value.id } };
  });
}
export function disableSoDRule(auth: AuthContext, id: string, changeId: string) {
  return operation(auth, changeId, "SOD.RULE.DISABLE", "sod.manage", async tx => {
    if (!await tx.soDRule.findFirst({ where: { ...context(auth), id } })) throw new CanonicalAdminError("NOT_FOUND", 404);
    const value = await tx.soDRule.update({ where: { organizationId_tenantId_id: { ...context(auth), id } }, data: { enabled: false } });
    return { value, metadata: { policyId: value.policyId, ruleId: id } };
  });
}
export function checkSoD(auth: AuthContext, input: { subjectId: string; entitlementId: string; scope: string; resourceId?: string }, changeId: string) {
  return operation(auth, changeId, "SOD.EVALUATE", "sod.read", async tx => {
    const value = await evaluateSoD(tx, { ...context(auth), ...input, assignmentOperation: "CREATE" });
    return { value, auditResult: value.decision === "DENY" ? "DENIED" : "SUCCESS", metadata: { subjectId: input.subjectId, entitlementId: input.entitlementId } };
  });
}
export function listSoDConflicts(auth: AuthContext, changeId: string) {
  return operation(auth, changeId, "SOD.CONFLICT.READ", "sod.read", async tx => ({ value:
    await tx.canonicalAdminAuditEvent.findMany({ where: { ...context(auth), operation: "ASSIGNMENT.DENIED.SOD" }, orderBy: { occurredAt: "desc" }, take: 100 }) }));
}
