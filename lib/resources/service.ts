import { Prisma, ResourceScopeKind, ResourceType } from "@prisma/client";
import type { AuthContext } from "../auth/authorization-engine";
import { CanonicalAdminError } from "../admin/canonical-administration";
import { withTenantDb } from "../db/scoped-client";
import { evaluateResourceAccess } from "./authorization";
import { enforceSoD, SoDDeniedError } from "./sod";

const context = (auth: AuthContext) => ({ organizationId: auth.organizationId, tenantId: auth.tenantId });
const notFound = () => { throw new CanonicalAdminError("NOT_FOUND", 404); };

async function requireNative(tx: Prisma.TransactionClient, auth: AuthContext, key: string) {
  const subject = await tx.subject.findFirst({ where: { ...context(auth), id: auth.subjectId, lifecycleState: "ACTIVE" } });
  if (!subject) throw new CanonicalAdminError("FORBIDDEN", 403);
  const now = new Date();
  const grant = await tx.assignment.findFirst({ where: { ...context(auth), subjectId: auth.subjectId,
    status: "ACTIVE", source: { not: "LEGACY_ROLE" },
    OR: [{ validFrom: null }, { validFrom: { lte: now } }],
    AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: now } }] }],
    entitlement: { key, active: true, resourceScopeId: null },
  } });
  if (!grant) throw new CanonicalAdminError("FORBIDDEN", 403);
}

type Outcome<T> = { value: T } | { error: CanonicalAdminError };
/** A controlled DENY commits its canonical evidence before throwing outside. */
export async function operation<T>(auth: AuthContext, changeId: string, name: string, permission: string | null,
  work: (tx: Prisma.TransactionClient) => Promise<{ value: T; metadata?: Prisma.InputJsonObject; assignmentIds?: string[]; targetSubjectId?: string; auditResult?: "SUCCESS" | "DENIED" }>): Promise<T> {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(changeId)) throw new CanonicalAdminError("INVALID_CHANGE_ID", 400);
  const outcome = await withTenantDb<Outcome<T>>(auth, async tx => {
    // Serialization prevents simultaneous request replay from performing two writes.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${auth.organizationId}:${auth.tenantId}`}, 0))::text`;
    const previous = await tx.canonicalAdminAuditEvent.findFirst({ where: { ...context(auth), changeId } });
    if (previous) return { error: new CanonicalAdminError("CHANGE_ALREADY_APPLIED", 409) };
    const actor = await tx.subject.findFirst({ where: { ...context(auth), id: auth.subjectId } });
    if (!actor) return { error: new CanonicalAdminError("FORBIDDEN", 403) };
    let result: Awaited<ReturnType<typeof work>>;
    try {
      if (permission) await requireNative(tx, auth, permission);
      else if (actor.lifecycleState !== "ACTIVE") throw new CanonicalAdminError("FORBIDDEN", 403);
      result = await work(tx);
    } catch (error) {
      if (!(error instanceof CanonicalAdminError)) throw error; // DB error rolls everything back.
      await tx.canonicalAdminAuditEvent.create({ data: { ...context(auth), actorSubjectId: auth.subjectId,
        operation: error instanceof SoDDeniedError ? "ASSIGNMENT.DENIED.SOD" : `${name}.DENIED`, changeId, result: "DENIED",
        metadata: error instanceof SoDDeniedError ? error.metadata : { reasonCode: error.code } } });
      return { error };
    }
    await tx.canonicalAdminAuditEvent.create({ data: { ...context(auth), actorSubjectId: auth.subjectId,
      targetSubjectId: result.targetSubjectId, operation: name, changeId, result: result.auditResult ?? "SUCCESS",
      assignmentIds: result.assignmentIds ?? [], metadata: result.metadata ?? {} } });
    return { value: result.value };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

export function listResources(auth: AuthContext, changeId: string, after?: string) {
  return operation(auth, changeId, "RESOURCE.CATALOG.READ", "resources.read", async tx => ({
    value: await tx.resource.findMany({ where: { ...context(auth), ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 100 }),
  }));
}
export function readResource(auth: AuthContext, id: string, changeId: string) {
  return operation(auth, changeId, "RESOURCE.CATALOG.READ", "resources.read", async tx => {
    const value = await tx.resource.findFirst({ where: { ...context(auth), id } });
    if (!value) return notFound();
    return { value, metadata: { resourceId: id } };
  });
}
export function createResource(auth: AuthContext, input: { name: string; type: ResourceType }, changeId: string) {
  return operation(auth, changeId, "RESOURCE.CATALOG.CREATE", "resources.manage", async tx => {
    const value = await tx.resource.create({ data: { ...context(auth), ...input } });
    return { value, metadata: { resourceId: value.id, resourceType: value.type } };
  });
}
export function updateResource(auth: AuthContext, id: string, input: { name?: string; active?: boolean }, changeId: string) {
  return operation(auth, changeId, "RESOURCE.CATALOG.UPDATE", "resources.manage", async tx => {
    if (!await tx.resource.findFirst({ where: { ...context(auth), id } })) return notFound();
    const value = await tx.resource.update({ where: { organizationId_tenantId_id: { ...context(auth), id } }, data: input });
    return { value, metadata: { resourceId: id, active: value.active } };
  });
}
export function createScope(auth: AuthContext, input: { key: string; kind: ResourceScopeKind; resourceId?: string; resourceIds?: string[] }, changeId: string) {
  return operation(auth, changeId, "RESOURCE.SCOPE.CREATE", "resources.manage", async tx => {
    const ids = input.kind === "RESOURCE" ? [input.resourceId!] : input.resourceIds ?? [];
    if ((input.kind === "RESOURCE" && (!input.resourceId || input.resourceIds?.length)) ||
        (input.kind !== "RESOURCE" && input.resourceId) || (input.kind === "TENANT" && ids.length) || new Set(ids).size !== ids.length)
      throw new CanonicalAdminError("INVALID_SCOPE", 400);
    if (ids.length && await tx.resource.count({ where: { ...context(auth), id: { in: ids } } }) !== ids.length) return notFound();
    const value = await tx.resourceScope.create({ data: { ...context(auth), key: input.key, kind: input.kind,
      resourceId: input.resourceId ?? null } });
    if (input.kind === "RESOURCE_GROUP" && ids.length) await tx.resourceScopeMember.createMany({ data: ids.map(resourceId => ({ ...context(auth), scopeId: value.id, resourceId })) });
    return { value, metadata: { scopeId: value.id, scopeKind: value.kind, memberCount: ids.length } };
  });
}
export function listScopes(auth: AuthContext, changeId: string, after?: string) {
  return operation(auth, changeId, "RESOURCE.SCOPE.READ", "resources.read", async tx => ({ value:
    await tx.resourceScope.findMany({ where: { ...context(auth), ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 100, include: { members: true } }) }));
}
export function createEntitlement(auth: AuthContext, input: { scopeId: string; action: string; label: string }, changeId: string) {
  return operation(auth, changeId, "RESOURCE.ENTITLEMENT.CREATE", "resources.manage", async tx => {
    if (!await tx.resourceScope.findFirst({ where: { ...context(auth), id: input.scopeId, active: true } })) return notFound();
    const key = `resource-scope:${input.scopeId}:${input.action}`;
    const value = await tx.entitlement.create({ data: { ...context(auth), key, action: input.action,
      resource: "resource-scope", resourceScopeId: input.scopeId, description: input.label } });
    return { value, metadata: { entitlementId: value.id, scopeId: input.scopeId, action: input.action } };
  });
}
export function revokeEntitlement(auth: AuthContext, id: string, changeId: string) {
  return operation(auth, changeId, "RESOURCE.ENTITLEMENT.REVOKE", "resources.manage", async tx => {
    const row = await tx.entitlement.findFirst({ where: { ...context(auth), id, resourceScopeId: { not: null } } });
    if (!row) return notFound();
    const value = await tx.entitlement.update({ where: { organizationId_tenantId_id: { ...context(auth), id } }, data: { active: false } });
    const assignments = await tx.assignment.findMany({ where: { ...context(auth), entitlementId: id, status: "ACTIVE" }, select: { id: true } });
    await tx.assignment.updateMany({ where: { ...context(auth), entitlementId: id, status: "ACTIVE" }, data: { status: "REVOKED" } });
    return { value, metadata: { entitlementId: id }, assignmentIds: assignments.map(row => row.id) };
  });
}
export function listEntitlements(auth: AuthContext, changeId: string, after?: string) {
  return operation(auth, changeId, "RESOURCE.ENTITLEMENT.READ", "resources.read", async tx => ({ value:
    await tx.entitlement.findMany({ where: { ...context(auth), resourceScopeId: { not: null }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 100 }) }));
}
export function grantAssignment(auth: AuthContext, input: { subjectId: string; entitlementId: string; validUntil: Date }, changeId: string) {
  return operation(auth, changeId, "RESOURCE.ASSIGNMENT.GRANT", "assignments.manage", async tx => {
    if (input.subjectId === auth.subjectId) throw new CanonicalAdminError("SELF_GRANT_FORBIDDEN", 403);
    if (input.validUntil <= new Date()) throw new CanonicalAdminError("INVALID_EXPIRY", 400);
    const entitlement = await tx.entitlement.findFirst({ where: { ...context(auth), id: input.entitlementId, active: true, resourceScopeId: { not: null } }, include: { resourceScope: true } });
    const subject = await tx.subject.findFirst({ where: { ...context(auth), id: input.subjectId, lifecycleState: "ACTIVE" } });
    if (!entitlement?.resourceScope?.active || !subject) return notFound();
    // Grant authority is bounded by the actor's effective grant of this exact entitlement.
    const now = new Date();
    const authority = await tx.assignment.findFirst({ where: { ...context(auth), subjectId: auth.subjectId,
      entitlementId: entitlement.id, status: "ACTIVE", source: { not: "LEGACY_ROLE" },
      OR: [{ validFrom: null }, { validFrom: { lte: now } }],
      AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: input.validUntil } }] }],
    } });
    if (!authority) throw new CanonicalAdminError("GRANT_AUTHORITY_REQUIRED", 403);
    await enforceSoD(tx, { ...context(auth), subjectId: subject.id, entitlementId: entitlement.id,
      scope: entitlement.resourceScopeId!, assignmentOperation: "CREATE", validFrom: now, validUntil: input.validUntil });
    const value = await tx.assignment.create({ data: { ...context(auth), subjectId: subject.id,
      entitlementId: entitlement.id, source: "DIRECT", validFrom: now, validUntil: input.validUntil } });
    return { value, assignmentIds: [value.id], targetSubjectId: subject.id, metadata: { entitlementId: entitlement.id, scopeId: entitlement.resourceScopeId! } };
  });
}
export function revokeAssignment(auth: AuthContext, id: string, changeId: string) {
  return operation(auth, changeId, "RESOURCE.ASSIGNMENT.REVOKE", "assignments.manage", async tx => {
    const row = await tx.assignment.findFirst({ where: { ...context(auth), id, entitlement: { resourceScopeId: { not: null } } } });
    if (!row) return notFound();
    if (row.subjectId === auth.subjectId) throw new CanonicalAdminError("SELF_REVOKE_FORBIDDEN", 403);
    const value = await tx.assignment.update({ where: { organizationId_tenantId_id: { ...context(auth), id } }, data: { status: "REVOKED" } });
    return { value, assignmentIds: [id], targetSubjectId: row.subjectId, metadata: { entitlementId: row.entitlementId } };
  });
}
export function updateAssignment(auth: AuthContext, id: string, input: { entitlementId?: string; validUntil?: Date; status?: "ACTIVE" | "REVOKED" }, changeId: string) {
  return operation(auth, changeId, "RESOURCE.ASSIGNMENT.UPDATE", "assignments.manage", async tx => {
    const row = await tx.assignment.findFirst({ where: { ...context(auth), id, source: "DIRECT", entitlement: { resourceScopeId: { not: null } } } });
    if (!row) return notFound();
    if (row.subjectId === auth.subjectId) throw new CanonicalAdminError("SELF_MODIFY_FORBIDDEN", 403);
    const status = input.status ?? row.status;
    const entitlementId = input.entitlementId ?? row.entitlementId;
    const validUntil = input.validUntil ?? row.validUntil;
    if (status === "ACTIVE") {
      if (!validUntil || validUntil <= new Date()) throw new CanonicalAdminError("INVALID_EXPIRY", 400);
      const entitlement = await tx.entitlement.findFirst({ where: { ...context(auth), id: entitlementId, active: true, resourceScopeId: { not: null } }, include: { resourceScope: true } });
      if (!entitlement?.resourceScope?.active || !await tx.subject.findFirst({ where: { ...context(auth), id: row.subjectId, lifecycleState: "ACTIVE" } })) return notFound();
      const now = new Date();
      if (!await tx.assignment.findFirst({ where: { ...context(auth), subjectId: auth.subjectId, entitlementId, status: "ACTIVE", source: { not: "LEGACY_ROLE" },
        OR: [{ validFrom: null }, { validFrom: { lte: now } }], AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: validUntil } }] }] } })) throw new CanonicalAdminError("GRANT_AUTHORITY_REQUIRED", 403);
      await enforceSoD(tx, { ...context(auth), subjectId: row.subjectId, entitlementId, scope: entitlement.resourceScopeId!,
        assignmentOperation: row.status === "ACTIVE" ? "MODIFY" : "REACTIVATE", excludeAssignmentId: id, validFrom: now, validUntil });
    }
    const value = await tx.assignment.update({ where: { organizationId_tenantId_id: { ...context(auth), id } }, data: { entitlementId, validUntil, status } });
    return { value, assignmentIds: [id], targetSubjectId: row.subjectId, metadata: { entitlementId, status } };
  });
}
export function listAssignments(auth: AuthContext, changeId: string, after?: string) {
  return operation(auth, changeId, "RESOURCE.ASSIGNMENT.READ", "assignments.read", async tx => ({ value:
    await tx.assignment.findMany({ where: { ...context(auth), entitlement: { resourceScopeId: { not: null } }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 100, include: { entitlement: true } }) }));
}
export function checkAccess(auth: AuthContext, input: { resourceId: string; entitlementKey: string; action: string }, changeId: string) {
  return operation(auth, changeId, "RESOURCE.AUTHORIZATION.CHECK", null, async tx => {
    const value = await evaluateResourceAccess(tx, { ...auth, ...input });
    // Decision is persisted in metadata; a DENY is not a successful grant.
    return { value, auditResult: value.allowed ? "SUCCESS" : "DENIED", assignmentIds: value.assignmentIds, metadata: { resourceId: input.resourceId, allowed: value.allowed,
      reasonCode: value.reasonCode, entitlementIds: value.entitlementIds, scopeIds: value.scopeIds } };
  });
}
export function listAudit(auth: AuthContext, changeId: string, after?: string) {
  return operation(auth, changeId, "RESOURCE.AUDIT.READ", "audit.read", async tx => ({ value:
    await tx.canonicalAdminAuditEvent.findMany({ where: { ...context(auth), operation: { startsWith: "RESOURCE." }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 100 }) }));
}
