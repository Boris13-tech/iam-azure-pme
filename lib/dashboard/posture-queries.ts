// One read-only query per dashboard widget. Each runs inside the tenant RLS transaction and also
// filters on organizationId/tenantId explicitly (defense in depth). No score, no estimate.
import {
  AccessReviewCampaignStatus, AssignmentSource, IdentityAccountStatus, LocalAuthenticatorStatus, LocalAuthenticatorType,
  Prisma, ProviderType, ResourceScopeKind, ResourceType, SoDPolicyStatus, SubjectLifecycleState, SubjectType,
} from "@prisma/client";
import { ENTITLEMENT_CATALOG_V1 } from "../auth/entitlements-catalog";
import type { Breakdown, WidgetId, WidgetValue } from "./posture-contract";
import { WIDGETS } from "./posture-contract";

export type QueryContext = Readonly<{
  tx: Prisma.TransactionClient;
  scope: Readonly<{ organizationId: string; tenantId: string }>;
  viewerSubjectId: string;
  now: Date;
}>;
type QueryWidgetId = { [K in WidgetId]: (typeof WIDGETS)[K]["kind"] extends "query" ? K : never }[WidgetId];
export type PostureQueries = Record<QueryWidgetId, (q: QueryContext) => Promise<WidgetValue>>;

const DAY = 86_400_000;
const since = (now: Date, days: number) => new Date(now.getTime() - days * DAY);

/** Same semantics as isAssignmentEffective + active entitlement. */
const effective = (now: Date): Prisma.AssignmentWhereInput => ({
  status: "ACTIVE",
  OR: [{ validFrom: null }, { validFrom: { lte: now } }],
  AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: now } }] }],
  entitlement: { active: true },
});
const effectiveAnd = (q: QueryContext, ...extra: Prisma.AssignmentWhereInput[]): Prisma.AssignmentWhereInput =>
  ({ ...q.scope, AND: [effective(q.now), ...extra] });

/** Every enum bucket is present; an absent bucket is a real 0, not a missing value. */
function buckets<K extends string>(keys: readonly K[], rows: ReadonlyArray<{ key: string; count: number }>): Breakdown {
  const out: Record<string, number> = Object.fromEntries(keys.map(key => [key, 0]));
  for (const row of rows) out[row.key] = (out[row.key] ?? 0) + row.count;
  return Object.freeze(out);
}
const values = <T extends Record<string, string>>(e: T) => Object.values(e) as T[keyof T][];

const ADMIN_ACTIONS = new Set(["manage", "revoke", "disable", "link", "create", "update", "delete", "decide"]);
export const ADMINISTRATIVE_ENTITLEMENT_KEYS = ENTITLEMENT_CATALOG_V1.filter(key => ADMIN_ACTIONS.has(key.split(".")[1]));

export const PRIVILEGED_OPERATIONS = Object.freeze([
  "ASSIGNMENT.GRANT", "ASSIGNMENT.REVOKE", "RESOURCE.ASSIGNMENT.GRANT", "RESOURCE.ASSIGNMENT.REVOKE", "RESOURCE.ASSIGNMENT.UPDATE",
  "ROLE.GOVERNANCE.GRANT", "ROLE.GOVERNANCE.REVOKE", "SESSION.REVOKE", "IDENTITY_ACCOUNT.DISABLE", "IDENTITY_ACCOUNT.LINK",
  "SUBJECT.CREATE", "SUBJECT.UPDATE", "LOCAL_IDENTITY.RECOVERY_UNLOCK", "PROVIDER.CREATE", "PROVIDER.UPDATE",
  "RESOURCE.ENTITLEMENT.CREATE", "RESOURCE.ENTITLEMENT.REVOKE", "SOD.POLICY.CREATE", "SOD.POLICY.UPDATE", "SOD.RULE.CREATE",
  "SOD.RULE.DISABLE", "RESOURCE.ONBOARDING.BOOTSTRAP", "RESOURCE.ONBOARDING.BOOTSTRAP.REVOKE",
]);

const activeSession = (q: QueryContext): Prisma.SessionWhereInput => ({ ...q.scope, revokedAt: null, expiresAt: { gt: q.now } });

export const POSTURE_QUERIES: PostureQueries = {
  // ── Identity ──────────────────────────────────────────────────────────────
  "identity.subjectsByLifecycle": async q => buckets(values(SubjectLifecycleState),
    (await q.tx.subject.groupBy({ by: ["lifecycleState"], where: q.scope, _count: { _all: true } }))
      .map(r => ({ key: r.lifecycleState, count: r._count._all }))),
  "identity.subjectsByType": async q => buckets(values(SubjectType),
    (await q.tx.subject.groupBy({ by: ["type"], where: q.scope, _count: { _all: true } }))
      .map(r => ({ key: r.type, count: r._count._all }))),
  "identity.accountsByProvider": async q => {
    const rows = await q.tx.identityAccount.groupBy({ by: ["providerConnectionId", "status"], where: q.scope, _count: { _all: true } });
    const providers = await q.tx.providerConnection.findMany({ where: { organizationId: q.scope.organizationId,
      id: { in: [...new Set(rows.map(r => r.providerConnectionId))] } }, select: { id: true, providerType: true } });
    const type = new Map(providers.map(p => [p.id, p.providerType]));
    const keys = values(ProviderType).flatMap(p => values(IdentityAccountStatus).map(s => `${p}.${s}`));
    return buckets(keys, rows.map(r => ({ key: `${type.get(r.providerConnectionId) ?? "UNKNOWN"}.${r.status}`, count: r._count._all })));
  },
  "identity.recoveryRequiredSubjects": q => q.tx.subject.count({ where: { ...q.scope, lifecycleState: "RECOVERY_REQUIRED" } }),
  "identity.activeSubjectsWithoutActiveAccount": q => q.tx.subject.count({ where: { ...q.scope, lifecycleState: "ACTIVE",
    identities: { none: { status: "ACTIVE" } } } }),
  "identity.unresolvedProviderCollisions": q => q.tx.providerIdentityCollision.count({ where: { ...q.scope, resolvedAt: null } }),

  // ── Sessions & Authentication ─────────────────────────────────────────────
  "sessions.active": q => q.tx.session.count({ where: activeSession(q) }),
  "sessions.activeSubjects": async q => (await q.tx.session.groupBy({ by: ["subjectId"], where: activeSession(q) })).length,
  "sessions.activeByProvider": async q => {
    const rows = await q.tx.session.groupBy({ by: ["identityAccountId"], where: activeSession(q), _count: { _all: true } });
    const accounts = await q.tx.identityAccount.findMany({ where: { ...q.scope, id: { in: rows.map(r => r.identityAccountId) } },
      select: { id: true, providerConnection: { select: { providerType: true } } } });
    const type = new Map(accounts.map(a => [a.id, a.providerConnection.providerType]));
    return buckets(values(ProviderType), rows.map(r => ({ key: type.get(r.identityAccountId) ?? "UNKNOWN", count: r._count._all })));
  },
  "sessions.started24h": q => q.tx.session.count({ where: { ...q.scope, createdAt: { gte: since(q.now, 1) } } }),
  "sessions.started7d": q => q.tx.session.count({ where: { ...q.scope, createdAt: { gte: since(q.now, 7) } } }),
  "sessions.revoked7d": q => q.tx.session.count({ where: { ...q.scope, revokedAt: { gte: since(q.now, 7) } } }),
  "auth.localAuthenticatorsByStatus": async q => {
    const rows = await q.tx.localAuthenticator.groupBy({ by: ["type", "status"], where: q.scope, _count: { _all: true } });
    const keys = values(LocalAuthenticatorType).flatMap(t => values(LocalAuthenticatorStatus).map(s => `${t}.${s}`));
    return buckets(keys, rows.map(r => ({ key: `${r.type}.${r.status}`, count: r._count._all })));
  },
  "auth.compromisedLocalAuthenticators": q => q.tx.localAuthenticator.count({ where: { ...q.scope, status: "COMPROMISED" } }),
  "auth.lockedLocalIdentities": q => q.tx.localIdentity.count({ where: { ...q.scope,
    OR: [{ status: { in: ["LOCKED", "RECOVERY_REQUIRED"] } }, { lockedUntil: { gt: q.now } }] } }),
  "auth.pendingCredentialReenrollments": q => q.tx.credentialReenrollmentRequirement.count({ where: { ...q.scope, status: "PENDING" } }),
  "auth.localSignInEvidence7d": async q => {
    const where: Prisma.AuthenticationEvidenceWhereInput = { ...q.scope, source: "LOCAL_VERIFIER", occurredAt: { gte: since(q.now, 7) } };
    const [verified, rejected, phishingResistant] = await Promise.all([
      q.tx.authenticationEvidence.count({ where: { ...where, outcome: "VERIFIED" } }),
      q.tx.authenticationEvidence.count({ where: { ...where, outcome: "REJECTED" } }),
      q.tx.authenticationEvidence.count({ where: { ...where, outcome: "VERIFIED", phishingResistant: true } }),
    ]);
    return Object.freeze({ VERIFIED: verified, REJECTED: rejected, VERIFIED_PHISHING_RESISTANT: phishingResistant });
  },

  // ── Access ────────────────────────────────────────────────────────────────
  "access.effectiveAssignments": q => q.tx.assignment.count({ where: effectiveAnd(q) }),
  "access.effectiveHolders": async q => (await q.tx.assignment.groupBy({ by: ["subjectId"], where: effectiveAnd(q) })).length,
  "access.effectiveBySource": async q => buckets(values(AssignmentSource),
    (await q.tx.assignment.groupBy({ by: ["source"], where: effectiveAnd(q), _count: { _all: true } }))
      .map(r => ({ key: r.source, count: r._count._all }))),
  "access.timeBoundVsPermanent": async q => {
    const [timeBound, permanent] = await Promise.all([
      q.tx.assignment.count({ where: effectiveAnd(q, { validUntil: { not: null } }) }),
      q.tx.assignment.count({ where: effectiveAnd(q, { validUntil: null }) }),
    ]);
    return Object.freeze({ TIME_BOUND: timeBound, PERMANENT: permanent });
  },
  "access.administrativeEntitlementHolders": async q => {
    const rows = await q.tx.assignment.findMany({ where: effectiveAnd(q, { entitlement: { key: { in: [...ADMINISTRATIVE_ENTITLEMENT_KEYS] }, resourceScopeId: null } }),
      select: { subjectId: true, entitlement: { select: { key: true } } } });
    const holders = new Map<string, Set<string>>();
    for (const row of rows) holders.set(row.entitlement.key, (holders.get(row.entitlement.key) ?? new Set()).add(row.subjectId));
    return buckets(ADMINISTRATIVE_ENTITLEMENT_KEYS, [...holders].map(([key, set]) => ({ key, count: set.size })));
  },
  "access.nonActiveSubjectsWithEffectiveAccess": async q =>
    (await q.tx.assignment.groupBy({ by: ["subjectId"], where: effectiveAnd(q, { subject: { lifecycleState: { not: "ACTIVE" } } }) })).length,
  "access.expiringWithin7d": q => q.tx.assignment.count({ where: effectiveAnd(q, { validUntil: { lte: new Date(q.now.getTime() + 7 * DAY) } }) }),
  "access.activeRowsPastValidity": q => q.tx.assignment.count({ where: { ...q.scope, status: "ACTIVE", validUntil: { lte: q.now } } }),
  "access.effectiveLegacyRoleAssignments": q => q.tx.assignment.count({ where: effectiveAnd(q, { source: "LEGACY_ROLE" }) }),

  // ── Resources ─────────────────────────────────────────────────────────────
  "resources.activeByType": async q => buckets(values(ResourceType),
    (await q.tx.resource.groupBy({ by: ["type"], where: { ...q.scope, active: true }, _count: { _all: true } }))
      .map(r => ({ key: r.type, count: r._count._all }))),
  "resources.activeScopesByKind": async q => buckets(values(ResourceScopeKind),
    (await q.tx.resourceScope.groupBy({ by: ["kind"], where: { ...q.scope, active: true }, _count: { _all: true } }))
      .map(r => ({ key: r.kind, count: r._count._all }))),
  "resources.activeScopedEntitlements": q => q.tx.entitlement.count({ where: { ...q.scope, active: true, resourceScopeId: { not: null } } }),
  // Mirrors evaluateResourceAccess: ACTIVE subject, non-LEGACY_ROLE, active scope; RESOURCE / RESOURCE_GROUP / TENANT.
  "resources.withoutEffectiveHolder": async q => {
    const [resources, grants] = await Promise.all([
      q.tx.resource.findMany({ where: { ...q.scope, active: true }, select: { id: true } }),
      q.tx.assignment.findMany({ where: effectiveAnd(q, { source: { not: "LEGACY_ROLE" }, subject: { lifecycleState: "ACTIVE" },
        entitlement: { resourceScopeId: { not: null } } }),
        select: { entitlement: { select: { resourceScope: { select: { kind: true, active: true, resourceId: true, members: { select: { resourceId: true } } } } } } } }),
    ]);
    const covered = new Set<string>();
    for (const { entitlement: { resourceScope: scope } } of grants) {
      if (!scope?.active) continue;
      if (scope.kind === "TENANT") return 0;
      if (scope.kind === "RESOURCE" && scope.resourceId) covered.add(scope.resourceId);
      if (scope.kind === "RESOURCE_GROUP") for (const m of scope.members) covered.add(m.resourceId);
    }
    return resources.filter(r => !covered.has(r.id)).length;
  },
  "resources.providerBoundVsNative": async q => {
    const [providerBound, native] = await Promise.all([
      q.tx.resource.count({ where: { ...q.scope, active: true, providerConnectionId: { not: null } } }),
      q.tx.resource.count({ where: { ...q.scope, active: true, providerConnectionId: null } }),
    ]);
    return Object.freeze({ PROVIDER_BOUND: providerBound, NATIVE: native });
  },

  // ── Governance ────────────────────────────────────────────────────────────
  "governance.sodPoliciesByStatus": async q => buckets(values(SoDPolicyStatus),
    (await q.tx.soDPolicy.groupBy({ by: ["status"], where: q.scope, _count: { _all: true } }))
      .map(r => ({ key: r.status, count: r._count._all }))),
  "governance.sodEnabledRules": q => q.tx.soDRule.count({ where: { ...q.scope, enabled: true } }),
  "governance.sodDeniedAttempts30d": q => q.tx.canonicalAdminAuditEvent.count({ where: { ...q.scope,
    operation: "ASSIGNMENT.DENIED.SOD", occurredAt: { gte: since(q.now, 30) } } }),
  "governance.reviewCampaignsByStatus": async q => buckets(values(AccessReviewCampaignStatus),
    (await q.tx.accessReviewCampaign.groupBy({ by: ["status"], where: q.scope, _count: { _all: true } }))
      .map(r => ({ key: r.status, count: r._count._all }))),
  "governance.overdueReviewCampaigns": q => q.tx.accessReviewCampaign.count({ where: { ...q.scope, status: "OPEN", dueAt: { lt: q.now } } }),
  "governance.pendingReviewItems": q => q.tx.accessReviewItem.count({ where: { ...q.scope, reviewState: "PENDING", campaign: { status: "OPEN" } } }),
  "governance.reviewItemsRequiringRemediation": q => q.tx.accessReviewItem.count({ where: { ...q.scope, reviewState: "REQUIRES_REMEDIATION" } }),
  "governance.myPendingReviewDecisions": q => q.tx.accessReviewItem.count({ where: { ...q.scope, reviewerSubjectId: q.viewerSubjectId,
    decision: "PENDING", campaign: { status: "OPEN" } } }),

  // ── Recent Security Activity ──────────────────────────────────────────────
  "activity.recentChangesAndDenials": async q => Object.freeze((await q.tx.canonicalAdminAuditEvent.findMany({
    where: { ...q.scope, NOT: { operation: { endsWith: ".READ" } } }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 20,
    select: { id: true, operation: true, result: true, occurredAt: true, actor: { select: { name: true } }, target: { select: { name: true } } },
  })).map(e => Object.freeze({ id: e.id, operation: e.operation, result: e.result, occurredAt: e.occurredAt.toISOString(),
    actorName: e.actor?.name ?? null, targetName: e.target?.name ?? null }))),
  "activity.deniedOrFailed24h": q => q.tx.canonicalAdminAuditEvent.count({ where: { ...q.scope, result: { in: ["DENIED", "FAILURE"] }, occurredAt: { gte: since(q.now, 1) } } }),
  "activity.deniedOrFailed7d": q => q.tx.canonicalAdminAuditEvent.count({ where: { ...q.scope, result: { in: ["DENIED", "FAILURE"] }, occurredAt: { gte: since(q.now, 7) } } }),
  "activity.privilegedChanges7d": q => q.tx.canonicalAdminAuditEvent.count({ where: { ...q.scope, result: "SUCCESS",
    operation: { in: [...PRIVILEGED_OPERATIONS] }, occurredAt: { gte: since(q.now, 7) } } }),
};
