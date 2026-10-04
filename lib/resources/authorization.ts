import type { Prisma } from "@prisma/client";
import { withTenantDb } from "../db/scoped-client";

export type ResourceAccessRequest = {
  subjectId: string; organizationId: string; tenantId: string;
  resourceId: string; entitlementKey: string; action: string;
};
export type ResourceDecision = {
  allowed: boolean; reasonCode: "ALLOW" | "DENY";
  subjectId: string; resourceId: string; assignmentIds: string[];
  entitlementIds: string[]; scopeIds: string[];
};

/** Server-only evaluator. No provider claims, role names or legacy authority. */
export async function evaluateResourceAccess(tx: Prisma.TransactionClient, request: ResourceAccessRequest): Promise<ResourceDecision> {
  const deny: ResourceDecision = { allowed: false, reasonCode: "DENY", subjectId: request.subjectId,
    resourceId: request.resourceId, assignmentIds: [], entitlementIds: [], scopeIds: [] };
  if (Object.values(request).some(value => !value) || request.action === "*" || request.entitlementKey === "*") return deny;
  const scope = { organizationId: request.organizationId, tenantId: request.tenantId };
  const [subject, resource] = await Promise.all([
    tx.subject.findFirst({ where: { ...scope, id: request.subjectId, lifecycleState: "ACTIVE" } }),
    tx.resource.findFirst({ where: { ...scope, id: request.resourceId, active: true } }),
  ]);
  if (!subject || !resource) return deny;
  const now = new Date();
  const assignments = await tx.assignment.findMany({ where: {
    ...scope, subjectId: subject.id, status: "ACTIVE", source: { not: "LEGACY_ROLE" },
    OR: [{ validFrom: null }, { validFrom: { lte: now } }],
    AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: now } }] }],
    entitlement: { active: true, key: request.entitlementKey, action: request.action, resourceScopeId: { not: null } },
  }, include: { entitlement: { include: { resourceScope: { include: { members: true } } } } } });
  const matched = assignments.filter(assignment => {
    const target = assignment.entitlement.resourceScope;
    if (!target || !target.active || target.organizationId !== scope.organizationId || target.tenantId !== scope.tenantId) return false;
    if (target.kind === "RESOURCE") return target.resourceId === resource.id;
    if (target.kind === "RESOURCE_GROUP") return target.members.some(member => member.resourceId === resource.id);
    return target.kind === "TENANT";
  });
  if (!matched.length) return deny;
  return { ...deny, allowed: true, reasonCode: "ALLOW", assignmentIds: matched.map(row => row.id),
    entitlementIds: [...new Set(matched.map(row => row.entitlementId))],
    scopeIds: [...new Set(matched.map(row => row.entitlement.resourceScopeId!))] };
}

export async function authorize(request: ResourceAccessRequest): Promise<ResourceDecision> {
  try {
    return await withTenantDb(request, tx => evaluateResourceAccess(tx, request));
  } catch {
    // Infrastructure failures cannot become permission grants or leak DB details.
    return { allowed: false, reasonCode: "DENY", subjectId: request.subjectId, resourceId: request.resourceId,
      assignmentIds: [], entitlementIds: [], scopeIds: [] };
  }
}
