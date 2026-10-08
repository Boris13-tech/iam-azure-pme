import { withTenantDb } from "../db/scoped-client";
import { CanonicalAdminError } from "../admin/canonical-administration";
import { requireNative } from "./service";
import type { AuthContext } from "../auth/authorization-engine";

export const GOVERNANCE_ADMIN_V2 = ["sod.read", "sod.manage", "access_reviews.read", "access_reviews.create", "access_reviews.decide", "access_reviews.manage"] as const;
const sourceRef = "native-role:LUXIA_ORG_ADMIN:v2";
/** Explicit operator-directed tenant grant. Never invoked by login or migrations. */
export async function applyGovernanceAdminBundle(auth: AuthContext, targetSubjectId: string, changeId: string) {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(changeId)) throw new CanonicalAdminError("INVALID_CHANGE_ID", 400);
  return withTenantDb(auth, async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${auth.organizationId}:${auth.tenantId}`},0))::text`;
    await requireNative(tx, auth, "assignments.manage");
    const context = { organizationId: auth.organizationId, tenantId: auth.tenantId };
    const target = await tx.subject.findFirst({ where: { ...context, id: targetSubjectId, type: "HUMAN", lifecycleState: "ACTIVE" } });
    if (!target) throw new CanonicalAdminError("INVALID_TARGET_SUBJECT", 403);
    const prior = await tx.canonicalAdminAuditEvent.findFirst({ where: { ...context, changeId } });
    if (prior) {
      if (prior.operation !== "ROLE.GOVERNANCE.GRANT" || prior.result !== "SUCCESS" || prior.actorSubjectId !== auth.subjectId || prior.targetSubjectId !== targetSubjectId) throw new CanonicalAdminError("CHANGE_ID_CONFLICT", 409);
      const active = await tx.assignment.count({ where: { ...context, id: { in: prior.assignmentIds }, subjectId: targetSubjectId, status: "ACTIVE", sourceRef } });
      if (active !== GOVERNANCE_ADMIN_V2.length) throw new CanonicalAdminError("BUNDLE_NO_LONGER_ACTIVE", 409);
      return { assignmentIds: prior.assignmentIds, replay: true };
    }
    if (await tx.assignment.count({ where: { ...context, subjectId: targetSubjectId, sourceRef } })) throw new CanonicalAdminError("BUNDLE_ALREADY_EXISTS", 409);
    const assignmentIds: string[] = [];
    for (const key of GOVERNANCE_ADMIN_V2) {
      const [resource, action] = key.split(".");
      let entitlement = await tx.entitlement.findUnique({ where: { organizationId_tenantId_key: { ...context, key } } });
      if (entitlement && (!entitlement.active || entitlement.resourceScopeId !== null || entitlement.resource !== resource || entitlement.action !== action)) throw new CanonicalAdminError("ENTITLEMENT_COLLISION", 409);
      if (!entitlement) entitlement = await tx.entitlement.create({ data: { ...context, key, resource, action, description: `${sourceRef}:${key}` } });
      const row = await tx.assignment.create({ data: { ...context, subjectId: targetSubjectId, entitlementId: entitlement.id, source: "DIRECT", sourceRef } });
      assignmentIds.push(row.id);
    }
    await tx.canonicalAdminAuditEvent.create({ data: { ...context, actorSubjectId: auth.subjectId, targetSubjectId, operation: "ROLE.GOVERNANCE.GRANT", roleKey: "LUXIA_ORG_ADMIN", roleVersion: 2, assignmentIds, changeId, result: "SUCCESS", metadata: { entitlementKeys: [...GOVERNANCE_ADMIN_V2] } } });
    return { assignmentIds, replay: false };
  });
}

export async function rollbackGovernanceAdminBundle(auth: AuthContext, targetSubjectId: string, changeId: string) {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(changeId)) throw new CanonicalAdminError("INVALID_CHANGE_ID", 400);
  return withTenantDb(auth, async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${auth.organizationId}:${auth.tenantId}`},0))::text`;
    await requireNative(tx, auth, "assignments.manage");
    const context = { organizationId: auth.organizationId, tenantId: auth.tenantId };
    const prior = await tx.canonicalAdminAuditEvent.findFirst({ where: { ...context, changeId } });
    if (prior) {
      if (prior.operation !== "ROLE.GOVERNANCE.REVOKE" || prior.actorSubjectId !== auth.subjectId || prior.targetSubjectId !== targetSubjectId || prior.result !== "SUCCESS") throw new CanonicalAdminError("CHANGE_ID_CONFLICT", 409);
      return { assignmentIds: prior.assignmentIds, replay: true };
    }
    const assignments = await tx.assignment.findMany({ where: { ...context, subjectId: targetSubjectId, sourceRef, status: "ACTIVE" } });
    const assignmentIds = assignments.map(row => row.id);
    if (assignmentIds.length !== GOVERNANCE_ADMIN_V2.length) throw new CanonicalAdminError("BUNDLE_NO_LONGER_ACTIVE", 409);
    await tx.assignment.updateMany({ where: { ...context, id: { in: assignmentIds }, subjectId: targetSubjectId, sourceRef }, data: { status: "REVOKED" } });
    await tx.canonicalAdminAuditEvent.create({ data: { ...context, actorSubjectId: auth.subjectId, targetSubjectId, operation: "ROLE.GOVERNANCE.REVOKE", roleKey: "LUXIA_ORG_ADMIN", roleVersion: 2, assignmentIds, changeId, result: "SUCCESS", metadata: { entitlementKeys: [...GOVERNANCE_ADMIN_V2] } } });
    return { assignmentIds, replay: false };
  });
}
