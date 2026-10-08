import { Prisma } from "@prisma/client";
import { CanonicalAdminError } from "../admin/canonical-administration";

export type SoDRequest = {
  organizationId: string; tenantId: string; subjectId: string; entitlementId: string;
  resourceId?: string; scope: string; assignmentOperation: "CREATE" | "REACTIVATE" | "MODIFY";
  excludeAssignmentId?: string; validFrom?: Date; validUntil?: Date;
};
export type SoDDecision = { decision: "ALLOW"; safeReasonCode?: "SOD_POLICY_DISABLED" | "SOD_SCOPE_MISMATCH" }
  | { decision: "DENY"; policyId: string; ruleId: string; safeReasonCode: "SOD_CONFLICT" };

export class SoDDeniedError extends CanonicalAdminError {
  constructor(public readonly metadata: Prisma.InputJsonObject) { super("SOD_CONFLICT", 403); }
}

/** Called under the same tenant lock as the eventual assignment write. */
export async function evaluateSoD(tx: Prisma.TransactionClient, input: SoDRequest, validateInactiveState = false): Promise<SoDDecision> {
  const context = { organizationId: input.organizationId, tenantId: input.tenantId };
  const subject = await tx.subject.findFirst({ where: { ...context, id: input.subjectId, ...(validateInactiveState ? {} : { lifecycleState: "ACTIVE" as const }) } });
  const entitlement = await tx.entitlement.findFirst({ where: { ...context, id: input.entitlementId, active: true, resourceScopeId: input.scope } });
  if (!subject || !entitlement) throw new CanonicalAdminError("FORBIDDEN", 403);
  const scopes = await tx.resourceScope.findMany({ where: context, include: { members: true } });
  const resources = await tx.resource.findMany({ where: context, select: { id: true } });
  const ids = (scopeId: string) => {
    const scope = scopes.find(s => s.id === scopeId);
    // Conservative: do not ignore conflicts merely because a resource is temporarily inactive.
    return !scope ? [] : scope.kind === "TENANT" ? resources.map(r => r.id)
      : scope.kind === "RESOURCE" ? [scope.resourceId!] : scope.members.map(m => m.resourceId);
  };
  const proposed = ids(input.scope);
  if (input.resourceId && !proposed.includes(input.resourceId)) throw new CanonicalAdminError("SOD_SCOPE_MISMATCH", 403);
  const rules = await tx.soDRule.findMany({ where: { ...context, enabled: true,
    OR: [{ entitlementAId: input.entitlementId }, { entitlementBId: input.entitlementId }] }, include: { policy: true }, orderBy: { id: "asc" } });
  const start = input.validFrom ?? new Date();
  const end = input.validUntil;
  for (const rule of rules) {
    if (rule.policy.status !== "ACTIVE") continue;
    const otherId = rule.entitlementAId === input.entitlementId ? rule.entitlementBId : rule.entitlementAId;
    const assignments = await tx.assignment.findMany({ where: { ...context, subjectId: input.subjectId,
      id: input.excludeAssignmentId ? { not: input.excludeAssignmentId } : undefined,
      entitlementId: otherId, source: { not: "LEGACY_ROLE" }, status: "ACTIVE",
      AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: start } }] },
        ...(end ? [{ OR: [{ validFrom: null }, { validFrom: { lt: end } }] }] : [])],
    }, include: { entitlement: true } });
    const policyIds = ids(rule.policy.scopeId);
    if (assignments.some(a => a.entitlement.resourceScopeId &&
      ids(a.entitlement.resourceScopeId).some(id => proposed.includes(id) && policyIds.includes(id))))
      return { decision: "DENY", policyId: rule.policyId, ruleId: rule.id, safeReasonCode: "SOD_CONFLICT" };
  }
  return { decision: "ALLOW", safeReasonCode: rules.length && rules.every(r => r.policy.status === "DISABLED") ? "SOD_POLICY_DISABLED" : "SOD_SCOPE_MISMATCH" };
}

export async function enforceSoD(tx: Prisma.TransactionClient, input: SoDRequest) {
  const decision = await evaluateSoD(tx, input);
  if (decision.decision === "DENY") {
    const scope = await tx.resourceScope.findFirst({ where: { organizationId: input.organizationId, tenantId: input.tenantId, id: input.scope } });
    throw new SoDDeniedError({ subjectId: input.subjectId, entitlementId: input.entitlementId,
      resourceId: input.resourceId ?? scope?.resourceId ?? null, policyId: decision.policyId,
      ruleId: decision.ruleId, scopeType: scope?.kind ?? "TENANT" });
  }
}
