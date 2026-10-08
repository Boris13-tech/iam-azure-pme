import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AuthContext } from "../auth/authorization-engine";
import { CanonicalAdminError } from "../admin/canonical-administration";
import { withTenantDb } from "../db/scoped-client";
import { evaluateResourceAccess } from "./authorization";
import { evaluateSoD } from "./sod";
import { requireNative } from "./service";
import { INTERNAL_RESOURCE as capability, INTERNAL_ENTITLEMENT_KEY as key } from "./internal-capability";

const context = (auth: AuthContext) => ({ organizationId: auth.organizationId, tenantId: auth.tenantId });
const inScope = (auth: AuthContext) => auth.organizationId === capability.organizationId && auth.tenantId === capability.tenantId;
const deny = (code: string, status = 403): never => { throw new CanonicalAdminError(code, status); };
type Outcome<T> = { value: T } | { error: CanonicalAdminError };

async function locked<T>(auth: AuthContext, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return withTenantDb(auth, async tx => {
    // Same lock as existing resource administration and SoD writes.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${auth.organizationId}:${auth.tenantId}`}, 0))::text`;
    if (!await tx.subject.findFirst({ where: { ...context(auth), id: auth.subjectId } })) deny("NOT_FOUND", 404);
    return work(tx);
  });
}

/** Exact RESOURCE-only binding. A broad scope cannot substitute for this integration. */
export async function internalBinding(tx: Prisma.TransactionClient, auth: AuthContext) {
  if (!inScope(auth)) return false;
  const [resource, scope, entitlement] = await Promise.all([
    tx.resource.findFirst({ where: { ...context(auth), id: capability.resourceId } }),
    tx.resourceScope.findFirst({ where: { ...context(auth), id: capability.scopeId } }),
    tx.entitlement.findFirst({ where: { ...context(auth), id: capability.entitlementId } }),
  ]);
  return !!(resource?.active && resource.type === capability.type && !resource.providerConnectionId &&
    scope?.active && scope.kind === "RESOURCE" && scope.resourceId === resource.id &&
    entitlement?.active && entitlement.resourceScopeId === scope.id && entitlement.action === capability.action &&
    entitlement.key === key && entitlement.resource === "resource-scope");
}

/** Audits are committed in the same transaction as evaluation, before returning HTTP DENY. */
export async function exerciseInternalCapability(auth: AuthContext) {
  return locked(auth, async tx => {
    const binding = await internalBinding(tx, auth);
    const decision = binding ? await evaluateResourceAccess(tx, {
      ...auth, resourceId: capability.resourceId, entitlementKey: key, action: capability.action,
    }) : { allowed: false, assignmentIds: [] as string[], entitlementIds: [] as string[], scopeIds: [] as string[] };
    const evidence = await tx.canonicalAdminAuditEvent.create({ data: {
      ...context(auth), actorSubjectId: auth.subjectId, changeId: `capability:${randomUUID()}`,
      operation: "RESOURCE.CAPABILITY.READ", result: decision.allowed ? "SUCCESS" : "DENIED",
      assignmentIds: decision.assignmentIds,
      // Foreign tenant sees no binding IDs, grant state or other tenant information.
      metadata: inScope(auth) ? { resourceId: capability.resourceId, action: capability.action,
        reasonCode: decision.allowed ? "ALLOW" : "RESOURCE_ACCESS_DENIED",
        entitlementIds: decision.entitlementIds, scopeIds: decision.scopeIds } : { reasonCode: "RESOURCE_ACCESS_DENIED" },
    } });
    return { allowed: decision.allowed, evidenceId: evidence.id };
  });
}

export async function recordOnboardingRequestDenied(auth: AuthContext, reasonCode: "INVALID_REQUEST_BODY" | "INVALID_ORIGIN") {
  return locked(auth, tx => tx.canonicalAdminAuditEvent.create({ data: { ...context(auth), actorSubjectId: auth.subjectId,
    operation: "RESOURCE.ONBOARDING.REQUEST.DENIED", changeId: `onboarding-request:${randomUUID()}`, result: "DENIED",
    metadata: { reasonCode } } }));
}

type Plan = { version: 1; targetSubjectId: string; validUntil: string; expiresAt: string };
function parsePlan(metadata: Prisma.JsonValue | null): Plan {
  const plan = metadata as unknown as Plan;
  if (!plan || plan.version !== 1 || typeof plan.targetSubjectId !== "string" || typeof plan.validUntil !== "string" ||
      typeof plan.expiresAt !== "string" || !Number.isFinite(Date.parse(plan.validUntil)) || !Number.isFinite(Date.parse(plan.expiresAt)))
    return deny("INVALID_ONBOARDING_PLAN", 409);
  return plan;
}

export async function describeInternalOnboarding(auth: AuthContext) {
  return locked(auth, async tx => {
    if (!inScope(auth)) deny("NOT_FOUND", 404);
    await requireNative(tx, auth, "resources.read");
    await requireNative(tx, auth, "subjects.read");
    const subjects = await tx.subject.findMany({ where: { ...context(auth), lifecycleState: "ACTIVE" },
      select: { id: true, name: true, type: true }, orderBy: { id: "asc" }, take: 100 });
    return { capability, entitlementKey: key, configured: await internalBinding(tx, auth), subjects,
      delegation: "BLOCKED" as const, reasonCode: "FIRST_OWNER_BOOTSTRAP_REQUIRED" };
  });
}

export async function planInternalOnboarding(auth: AuthContext, targetSubjectId: string, validUntil: Date) {
  const outcome = await locked<Outcome<{ operationId: string; plan: Plan }>>(auth, async tx => {
    const changeId = `onboarding-plan:${randomUUID()}`;
    try {
      if (!inScope(auth)) deny("NOT_FOUND", 404);
      await requireNative(tx, auth, "resources.manage");
      await requireNative(tx, auth, "subjects.read");
      const now = Date.now();
      if (!Number.isFinite(validUntil.getTime()) || validUntil.getTime() <= now || validUntil.getTime() > now + 3_600_000)
        deny("VALIDITY_MUST_BE_BOUNDED_TO_ONE_HOUR", 400);
      if (!await tx.subject.findFirst({ where: { ...context(auth), id: targetSubjectId, lifecycleState: "ACTIVE" } })) deny("NOT_FOUND", 404);
      // Retried plan issuance with the same input reuses the server-issued identifier.
      const prior = await tx.canonicalAdminAuditEvent.findFirst({ where: { ...context(auth), actorSubjectId: auth.subjectId,
        operation: "RESOURCE.ONBOARDING.PLAN", result: "SUCCESS",
        AND: [{ metadata: { path: ["targetSubjectId"], equals: targetSubjectId } },
          { metadata: { path: ["validUntil"], equals: validUntil.toISOString() } },
          { metadata: { path: ["expiresAt"], gt: new Date(now).toISOString() } }],
      }, orderBy: { occurredAt: "desc" } });
      if (prior) return { value: { operationId: prior.id, plan: parsePlan(prior.metadata) } };
      const plan: Plan = { version: 1, targetSubjectId, validUntil: validUntil.toISOString(), expiresAt: new Date(now + 600_000).toISOString() };
      const receipt = await tx.canonicalAdminAuditEvent.create({ data: { ...context(auth), actorSubjectId: auth.subjectId,
        targetSubjectId, operation: "RESOURCE.ONBOARDING.PLAN", changeId, result: "SUCCESS", metadata: plan } });
      return { value: { operationId: receipt.id, plan } };
    } catch (error) {
      if (!(error instanceof CanonicalAdminError)) throw error;
      await tx.canonicalAdminAuditEvent.create({ data: { ...context(auth), actorSubjectId: auth.subjectId,
        operation: "RESOURCE.ONBOARDING.PLAN.DENIED", changeId, result: "DENIED", metadata: { reasonCode: error.code } } });
      return { error };
    }
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

async function receipt(tx: Prisma.TransactionClient, auth: AuthContext, operationId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(operationId)) deny("NOT_FOUND", 404);
  const row = await tx.canonicalAdminAuditEvent.findFirst({ where: { ...context(auth), id: operationId,
    actorSubjectId: auth.subjectId, operation: "RESOURCE.ONBOARDING.PLAN", result: "SUCCESS" } });
  if (!row) return deny("NOT_FOUND", 404);
  return parsePlan(row.metadata);
}

/** Controlled denial sentinel ensures rollback cannot erase refusal evidence. */
async function phase<T>(auth: AuthContext, operationId: string, name: "CONFIGURE" | "GRANT", work: (tx: Prisma.TransactionClient, plan: Plan, replay: boolean) => Promise<T>) {
  const outcome = await locked<Outcome<T>>(auth, async tx => {
    const changeId = `onboarding:${operationId}:${name}`;
    const previous = await tx.canonicalAdminAuditEvent.findFirst({ where: { ...context(auth), changeId } });
    try {
      if (!inScope(auth)) deny("NOT_FOUND", 404);
      const plan = await receipt(tx, auth, operationId);
      await requireNative(tx, auth, "resources.manage");
      if (!await tx.subject.findFirst({ where: { ...context(auth), id: plan.targetSubjectId, lifecycleState: "ACTIVE" } })) deny("NOT_FOUND", 404);
      if (previous?.actorSubjectId !== undefined && previous.actorSubjectId !== auth.subjectId) deny("NOT_FOUND", 404);
      if (previous?.result === "DENIED") deny((previous.metadata as { reasonCode: string }).reasonCode);
      if (!previous && (Date.parse(plan.expiresAt) <= Date.now() || Date.parse(plan.validUntil) <= Date.now())) deny("ONBOARDING_PLAN_EXPIRED", 409);
      const value = await work(tx, plan, !!previous);
      if (!previous) await tx.canonicalAdminAuditEvent.create({ data: { ...context(auth), actorSubjectId: auth.subjectId,
        targetSubjectId: plan.targetSubjectId, operation: `RESOURCE.ONBOARDING.${name}`, changeId, result: "SUCCESS",
        metadata: { resourceId: capability.resourceId, scopeId: capability.scopeId, entitlementId: capability.entitlementId, operationId } } });
      return { value };
    } catch (error) {
      if (!(error instanceof CanonicalAdminError)) throw error;
      // A replay does not duplicate a persisted DENY. A newly invalid replay keeps
      // its independent refusal evidence without overwriting the successful receipt.
      const denialChange = previous?.result === "SUCCESS" ? `${changeId}:denied` : changeId;
      if (!await tx.canonicalAdminAuditEvent.findFirst({ where: { ...context(auth), changeId: denialChange } }))
        await tx.canonicalAdminAuditEvent.create({ data: { ...context(auth), actorSubjectId: auth.subjectId,
          operation: `RESOURCE.ONBOARDING.${name}.DENIED`, changeId: denialChange, result: "DENIED", metadata: { reasonCode: error.code } } });
      return { error };
    }
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

/** Creates no Assignment, Subject, account, role or tenant. No partial configuration. */
export function configureInternalOnboarding(auth: AuthContext, operationId: string) {
  return phase(auth, operationId, "CONFIGURE", async (tx, _plan, replay) => {
    const [resource, scope, entitlement, sameKey, sameScopeKey] = await Promise.all([
      tx.resource.findFirst({ where: { ...context(auth), id: capability.resourceId } }),
      tx.resourceScope.findFirst({ where: { ...context(auth), id: capability.scopeId } }),
      tx.entitlement.findFirst({ where: { ...context(auth), id: capability.entitlementId } }),
      tx.entitlement.findFirst({ where: { ...context(auth), key } }),
      tx.resourceScope.findFirst({ where: { ...context(auth), key: "luxia-internal-resource-test-v1" } }),
    ]);
    if (resource || scope || entitlement || sameKey || sameScopeKey) {
      if (!await internalBinding(tx, auth)) deny("RESOURCE_BINDING_CONFLICT", 409);
    } else {
      if (replay) deny("RESOURCE_BINDING_CONFLICT", 409);
      await tx.resource.create({ data: { ...context(auth), id: capability.resourceId, name: capability.name, type: capability.type } });
      await tx.resourceScope.create({ data: { ...context(auth), id: capability.scopeId, key: "luxia-internal-resource-test-v1", kind: "RESOURCE", resourceId: capability.resourceId } });
      await tx.entitlement.create({ data: { ...context(auth), id: capability.entitlementId, key, action: capability.action,
        resource: "resource-scope", resourceScopeId: capability.scopeId, description: "Read the dedicated LUXIA internal capability only" } });
    }
    return { resourceId: capability.resourceId, scopeId: capability.scopeId, entitlementId: capability.entitlementId,
      delegation: "BLOCKED" as const, assignmentsCreated: 0, replay };
  });
}

export function requestInternalGrant(auth: AuthContext, operationId: string) {
  return phase(auth, operationId, "GRANT", async (tx, plan) => {
    await requireNative(tx, auth, "assignments.manage");
    if (plan.targetSubjectId === auth.subjectId) deny("SELF_GRANT_FORBIDDEN");
    // No browser flag, role name or resources.manage can approve a first owner.
    return deny("FIRST_OWNER_BOOTSTRAP_REQUIRED");
  });
}

export async function previewInternalOnboarding(auth: AuthContext, operationId: string) {
  return locked(auth, async tx => {
    if (!inScope(auth)) deny("NOT_FOUND", 404);
    await requireNative(tx, auth, "resources.read");
    const plan = await receipt(tx, auth, operationId);
    if (Date.parse(plan.expiresAt) <= Date.now() || Date.parse(plan.validUntil) <= Date.now()) deny("ONBOARDING_PLAN_EXPIRED", 409);
    const configured = await internalBinding(tx, auth);
    const authority = configured ? await tx.assignment.findFirst({ where: { ...context(auth), subjectId: auth.subjectId,
      entitlementId: capability.entitlementId, status: "ACTIVE", source: { not: "LEGACY_ROLE" },
      OR: [{ validFrom: null }, { validFrom: { lte: new Date() } }],
      AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: new Date(plan.validUntil) } }] }],
    }, select: { id: true } }) : null;
    const sod = configured ? await evaluateSoD(tx, { ...context(auth), subjectId: plan.targetSubjectId,
      entitlementId: capability.entitlementId, scope: capability.scopeId, resourceId: capability.resourceId,
      assignmentOperation: "CREATE", validUntil: new Date(plan.validUntil) }) : null;
    return { operationId, plan, capability, entitlementKey: key, configured, sod, effectiveAuthority: !!authority,
      delegation: "BLOCKED" as const, reasonCode: plan.targetSubjectId === auth.subjectId ? "SELF_GRANT_FORBIDDEN" : "FIRST_OWNER_BOOTSTRAP_REQUIRED" };
  });
}
