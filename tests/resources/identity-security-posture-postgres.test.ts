// Enterprise Identity Security Dashboard v1: real app_user PostgreSQL / forced RLS certification.
// Exact expected values from a fully known fixture; restricted, unavailable, cross-tenant,
// privacy, read-only and audit (D1) behaviour.
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { CanonicalAdminError } from "../../lib/admin/canonical-administration";
import { loadIdentitySecurityPosture, POSTURE_AUDIT_OPERATION } from "../../lib/dashboard/posture";
import type { PostureResponse, Widget, WidgetId } from "../../lib/dashboard/posture-contract";

const org = randomUUID(), tenant = randomUUID(), tenantB = randomUUID();
const A = { organizationId: org, tenantId: tenant }, B = { organizationId: org, tenantId: tenantB };
const ids = { V: randomUUID(), L: randomUUID(), N: randomUUID(), s1: randomUUID(), s2: randomUUID(), s3: randomUUID(), s4: randomUUID(), vb: randomUUID() };
const acct = { V: randomUUID(), L: randomUUID(), N: randomUUID(), s1: randomUUID(), s2: randomUUID(), s3: randomUUID(), vb: randomUUID() };
const entra = randomUUID(), local = randomUUID();
const R1 = randomUUID(), R2 = randomUUID(), R3 = randomUUID(), S1 = randomUUID(), S2 = randomUUID(), E1 = randomUUID(), E1w = randomUUID();
const MARK = { ip: `IPHASH-${randomUUID()}`, ua: `UAHASH-${randomUUID()}`, sess: `SESSION-${randomUUID()}`, cred: `CRED-${randomUUID()}`, ext: `EXT-${randomUUID()}` };
const HOUR = 3_600_000, DAY = 24 * HOUR;
const auth = (subjectId: string, identityAccountId: string, scope = A) => ({ sessionId: randomUUID(), ...scope, subjectId, identityAccountId });
let owner: PrismaClient;

const VIEWER_KEYS = ["subjects.read", "identity_accounts.read", "sessions.read", "providers.read", "assignments.read",
  "resources.read", "sod.read", "access_reviews.read", "access_reviews.decide", "audit.read", "assignments.manage"];

async function seed(tx: Prisma.TransactionClient, now: number) {
  await tx.organization.create({ data: { id: org, name: "Posture fixture org" } });
  for (const id of [tenant, tenantB]) await tx.tenant.create({ data: { id, organizationId: org, name: `Posture tenant ${id === tenant ? "A" : "B"}` } });
  await tx.providerConnection.create({ data: { id: entra, organizationId: org, providerType: "MICROSOFT_ENTRA", externalScopeId: randomUUID(), name: "Entra" } });
  await tx.providerConnection.create({ data: { id: local, organizationId: org, providerType: "LUXIA_LOCAL", externalScopeId: randomUUID(), name: "Local" } });
  const subject = (id: string, name: string, type: "HUMAN" | "SERVICE", lifecycleState: "ACTIVE" | "SUSPENDED" | "RECOVERY_REQUIRED", scope = A) =>
    tx.subject.create({ data: { ...scope, id, name, type, lifecycleState } });
  await subject(ids.V, "Viewer V", "HUMAN", "ACTIVE"); await subject(ids.L, "Limited L", "HUMAN", "ACTIVE");
  await subject(ids.N, "No-rights N", "HUMAN", "ACTIVE"); await subject(ids.s1, "Subject One", "HUMAN", "ACTIVE");
  await subject(ids.s2, "Suspended Two", "HUMAN", "SUSPENDED"); await subject(ids.s3, "Recovery Three", "HUMAN", "RECOVERY_REQUIRED");
  await subject(ids.s4, "Service Four", "SERVICE", "ACTIVE"); await subject(ids.vb, "Tenant B viewer", "HUMAN", "ACTIVE", B);
  const account = (id: string, subjectId: string, providerConnectionId: string, status: "ACTIVE" | "DISABLED", scope = A, ext: string = randomUUID()) =>
    tx.identityAccount.create({ data: { ...scope, id, subjectId, providerConnectionId, externalObjectId: ext, status,
      disabledAt: status === "DISABLED" ? new Date(now) : null } });
  await account(acct.V, ids.V, entra, "ACTIVE", A, MARK.ext); await account(acct.L, ids.L, entra, "ACTIVE");
  await account(acct.N, ids.N, entra, "ACTIVE"); await account(acct.s1, ids.s1, entra, "ACTIVE");
  await account(acct.s2, ids.s2, local, "ACTIVE"); await account(acct.s3, ids.s3, entra, "DISABLED"); await account(acct.vb, ids.vb, entra, "ACTIVE", B);
  await tx.providerIdentityCollision.create({ data: { ...A, providerConnectionId: entra, externalObjectId: randomUUID(), reasonCode: "FIXTURE", evidence: {} } });
  await tx.providerIdentityCollision.create({ data: { ...A, providerConnectionId: entra, externalObjectId: randomUUID(), reasonCode: "FIXTURE", evidence: {}, resolvedAt: new Date(now) } });

  const session = (id: string, subjectId: string, identityAccountId: string, createdAt: number, expiresAt: number, revokedAt?: number, scope = A) =>
    tx.session.create({ data: { ...scope, id, subjectId, identityAccountId, createdAt: new Date(createdAt), expiresAt: new Date(expiresAt),
      revokedAt: revokedAt ? new Date(revokedAt) : null, ipHash: MARK.ip, userAgentHash: MARK.ua } });
  await session(MARK.sess, ids.V, acct.V, now - HOUR, now + DAY);
  await session(randomUUID(), ids.s1, acct.s1, now - HOUR, now + DAY);
  await session(randomUUID(), ids.s1, acct.s1, now - 2 * HOUR, now + DAY);
  await session(randomUUID(), ids.s2, acct.s2, now - 3 * DAY, now - 2 * DAY);
  await session(randomUUID(), ids.L, acct.L, now - 2 * DAY, now + DAY, now - 2 * DAY + HOUR);
  await session(randomUUID(), ids.vb, acct.vb, now - HOUR, now + DAY, undefined, B);

  await tx.localIdentity.create({ data: { ...A, identityAccountId: acct.s2, principalName: `s2-${randomUUID()}`, status: "LOCKED" } });
  await tx.localAuthenticator.create({ data: { ...A, identityAccountId: acct.s2, type: "PASSKEY", status: "ACTIVE", credentialId: MARK.cred, publicKey: "fixture-public-key" } });
  await tx.localAuthenticator.create({ data: { ...A, identityAccountId: acct.s2, type: "PASSKEY", status: "COMPROMISED", credentialId: randomUUID(), publicKey: "fixture-public-key", compromisedAt: new Date(now) } });
  await tx.credentialReenrollmentRequirement.create({ data: { ...A, subjectId: ids.s2, originalCredentialId: randomUUID(), recoveryEpoch: BigInt(1), reasonCode: "FIXTURE" } });
  await tx.credentialReenrollmentRequirement.create({ data: { ...A, subjectId: ids.s2, originalCredentialId: randomUUID(), recoveryEpoch: BigInt(1), reasonCode: "FIXTURE", status: "COMPLETED", completedCredentialId: randomUUID(), completedAt: new Date(now) } });
  const evidence = (outcome: "VERIFIED" | "REJECTED", phishingResistant: boolean, at: number) => tx.authenticationEvidence.create({ data: { ...A,
    subjectId: ids.s2, identityAccountId: acct.s2, providerConnectionId: local, method: "PASSKEY", outcome, assuranceLevel: "HIGH",
    assuranceProfile: "fixture", assuranceProfileVersion: 1, phishingResistant, hardwareBound: true, userVerification: "VERIFIED",
    source: "LOCAL_VERIFIER", sourceRef: randomUUID(), verifierPolicyVersion: 1, operationId: randomUUID(), reasonCode: "FIXTURE", occurredAt: new Date(at) } });
  await evidence("VERIFIED", true, now - DAY); await evidence("REJECTED", false, now - 2 * DAY); await evidence("VERIFIED", true, now - 10 * DAY);

  // Native entitlements and assignments.
  const ent = async (key: string, scope = A) => (await tx.entitlement.create({ data: { ...scope, key, action: key.split(".")[1], resource: key.split(".")[0] } })).id;
  const keys = new Map<string, string>();
  for (const key of VIEWER_KEYS) keys.set(key, await ent(key));
  for (const key of VIEWER_KEYS) await tx.assignment.create({ data: { ...A, subjectId: ids.V, entitlementId: keys.get(key)!, source: "DIRECT" } });
  await tx.assignment.create({ data: { ...A, subjectId: ids.L, entitlementId: keys.get("subjects.read")!, source: "DIRECT" } });
  await tx.assignment.create({ data: { ...A, subjectId: ids.s1, entitlementId: keys.get("audit.read")!, source: "LEGACY_ROLE", sourceRef: "legacy-role:fixture" } });
  const vbKey = await ent("subjects.read", B);
  await tx.assignment.create({ data: { ...B, subjectId: ids.vb, entitlementId: vbKey, source: "DIRECT" } });

  // Resources: R1 (API, covered by s1), R2 (APPLICATION, provider-bound, no holder), R3 inactive.
  await tx.resource.create({ data: { ...A, id: R1, name: "R1", type: "API" } });
  await tx.resource.create({ data: { ...A, id: R2, name: "R2", type: "APPLICATION", providerConnectionId: entra } });
  await tx.resource.create({ data: { ...A, id: R3, name: "R3", type: "DATABASE", active: false } });
  await tx.resource.create({ data: { ...B, id: randomUUID(), name: "B resource", type: "API" } });
  await tx.resourceScope.create({ data: { ...A, id: S1, key: `r1-${S1}`, kind: "RESOURCE", resourceId: R1 } });
  await tx.resourceScope.create({ data: { ...A, id: S2, key: `r2-${S2}`, kind: "RESOURCE", resourceId: R2 } });
  await tx.entitlement.create({ data: { ...A, id: E1, key: `resource-scope:${S1}:resource.read`, action: "resource.read", resource: "resource-scope", resourceScopeId: S1 } });
  await tx.entitlement.create({ data: { ...A, id: E1w, key: `resource-scope:${S1}:resource.write`, action: "resource.write", resource: "resource-scope", resourceScopeId: S1 } });
  const s1Grant = await tx.assignment.create({ data: { ...A, subjectId: ids.s1, entitlementId: E1, source: "DIRECT", validUntil: new Date(now + 3 * DAY) } });
  const s2Grant = await tx.assignment.create({ data: { ...A, subjectId: ids.s2, entitlementId: E1, source: "DIRECT" } });
  await tx.assignment.create({ data: { ...A, subjectId: ids.s1, entitlementId: E1w, source: "DIRECT", validUntil: new Date(now - DAY) } }); // stale ACTIVE
  await tx.assignment.create({ data: { ...A, subjectId: ids.s1, entitlementId: E1w, source: "DIRECT", status: "REVOKED" } });

  // Governance.
  const p1 = await tx.soDPolicy.create({ data: { ...A, key: `p1-${randomUUID()}`, scopeId: S1, status: "ACTIVE" } });
  const [ruleA, ruleB] = [E1, E1w].sort(); // SoDRule_check: entitlementAId < entitlementBId
  await tx.soDRule.create({ data: { ...A, policyId: p1.id, entitlementAId: ruleA, entitlementBId: ruleB } });
  await tx.soDPolicy.create({ data: { ...A, key: `p2-${randomUUID()}`, scopeId: S2, status: "DISABLED" } });
  const c1 = await tx.accessReviewCampaign.create({ data: { ...A, name: "Overdue", scopeId: S1, scopeType: "RESOURCE", resourceId: R1,
    reviewerSubjectId: ids.V, createdBySubjectId: ids.V, startsAt: new Date(now - 5 * DAY), dueAt: new Date(now - DAY) } });
  const c2 = await tx.accessReviewCampaign.create({ data: { ...A, name: "Done", scopeId: S1, scopeType: "RESOURCE", resourceId: R1,
    reviewerSubjectId: ids.V, createdBySubjectId: ids.V, startsAt: new Date(now - 9 * DAY), dueAt: new Date(now - 6 * DAY), status: "COMPLETED", completedAt: new Date(now - 6 * DAY) } });
  const item = (campaignId: string, a: { id: string; subjectId: string }, extra: Partial<Prisma.AccessReviewItemUncheckedCreateInput> = {}) =>
    tx.accessReviewItem.create({ data: { ...A, campaignId, subjectId: a.subjectId, assignmentId: a.id, entitlementId: E1, resourceId: R1, scopeId: S1,
      resourceIds: [R1], assignmentVersion: new Date(now), entitlementVersion: new Date(now), reviewerSubjectId: ids.V, ...extra } });
  await item(c1.id, s1Grant);
  await item(c2.id, s2Grant, { reviewState: "REQUIRES_REMEDIATION" }); // decision stays PENDING (DB check)

  // Audit trail.
  const audit = (operation: string, result: "SUCCESS" | "DENIED" | "FAILURE", at: number, targetSubjectId?: string) =>
    tx.canonicalAdminAuditEvent.create({ data: { ...A, actorSubjectId: ids.V, targetSubjectId, operation, result, changeId: `fixture:${randomUUID()}`, occurredAt: new Date(at) } });
  await audit("ASSIGNMENT.GRANT", "SUCCESS", now - HOUR, ids.s1);
  await audit("SESSION.REVOKE", "SUCCESS", now - 2 * DAY, ids.L);
  await audit("SUBJECT.READ", "SUCCESS", now - 30 * 60_000);
  await audit("AUTHORIZATION.DENIED", "DENIED", now - 2 * HOUR);
  await audit("ASSIGNMENT.DENIED.SOD", "DENIED", now - 2 * DAY);
  await audit("RESOURCE.CATALOG.UPDATE", "FAILURE", now - 3 * DAY);
  await audit("ASSIGNMENT.DENIED.SOD", "DENIED", now - 40 * DAY);
}

const widget = (r: PostureResponse, id: WidgetId): Widget => Object.values(r.sections).flat().find(w => w.id === id)!;
const value = (r: PostureResponse, id: WidgetId) => { const w = widget(r, id); expect(w.state, id).toBe("ok"); return (w as { value: unknown }).value; };
const nonZero = (v: unknown) => Object.fromEntries(Object.entries(v as Record<string, number>).filter(([, n]) => n > 0));
const counts = () => withTenantDb(A, async tx => Promise.all([tx.subject.count(), tx.identityAccount.count(), tx.session.count(), tx.assignment.count(),
  tx.entitlement.count(), tx.resource.count(), tx.resourceScope.count(), tx.soDPolicy.count(), tx.accessReviewItem.count(), tx.localAuthenticator.count()]));

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("Identity Security Posture v1 — app_user PostgreSQL/RLS", () => {
  let now: number;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!(["localhost", "127.0.0.1"].includes(url.hostname) || (url.hostname === "ep-weathered-grass-ah5vrehj-pooler.c-3.us-east-1.aws.neon.tech" && ["/luxia_reviews_cert","/luxia_resources_diag_awake01","/luxia_resources_diag_concurrency02","/luxia_resources_diag_global01","/luxia_resources_diag_ci02","/luxia_resources_diag_ci03","/luxia_resources_diag_ci04","/luxia_resources_diag_ci05"].includes(url.pathname)))) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    now = Date.now();
    for (const scope of [A, B]) await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${scope.organizationId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${scope.tenantId}, true)`;
      if (scope === A) await seed(tx, now);
    }, { timeout: 120_000 });
  }, 180_000);
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });

  it("runtime is non-privileged app_user", async () => {
    const [role] = await withTenantDb(A, tx => tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("full viewer: exact real values per widget", async () => {
    const r = await loadIdentitySecurityPosture(auth(ids.V, acct.V), { now: new Date(now) });
    expect(r.organization.name).toBe("Posture fixture org");
    expect(nonZero(value(r, "identity.subjectsByLifecycle"))).toEqual({ ACTIVE: 5, SUSPENDED: 1, RECOVERY_REQUIRED: 1 });
    expect(nonZero(value(r, "identity.subjectsByType"))).toEqual({ HUMAN: 6, SERVICE: 1 });
    expect(nonZero(value(r, "identity.accountsByProvider"))).toEqual({ "MICROSOFT_ENTRA.ACTIVE": 4, "MICROSOFT_ENTRA.DISABLED": 1, "LUXIA_LOCAL.ACTIVE": 1 });
    expect(value(r, "identity.recoveryRequiredSubjects")).toBe(1);
    expect(value(r, "identity.activeSubjectsWithoutActiveAccount")).toBe(1);
    expect(value(r, "identity.unresolvedProviderCollisions")).toBe(1);
    expect(value(r, "sessions.active")).toBe(3);
    expect(value(r, "sessions.activeSubjects")).toBe(2);
    expect(nonZero(value(r, "sessions.activeByProvider"))).toEqual({ MICROSOFT_ENTRA: 3 });
    expect(value(r, "sessions.started24h")).toBe(3);
    expect(value(r, "sessions.started7d")).toBe(5);
    expect(value(r, "sessions.revoked7d")).toBe(1);
    expect(nonZero(value(r, "auth.localAuthenticatorsByStatus"))).toEqual({ "PASSKEY.ACTIVE": 1, "PASSKEY.COMPROMISED": 1 });
    expect(value(r, "auth.compromisedLocalAuthenticators")).toBe(1);
    expect(value(r, "auth.lockedLocalIdentities")).toBe(1);
    expect(value(r, "auth.pendingCredentialReenrollments")).toBe(1);
    expect(value(r, "auth.localSignInEvidence7d")).toEqual({ VERIFIED: 1, REJECTED: 1, VERIFIED_PHISHING_RESISTANT: 1 });
    expect(widget(r, "auth.entraSignInEvidence")).toEqual({ id: "auth.entraSignInEvidence", state: "unavailable", reason: "ENTRA_EVIDENCE_NOT_RECORDED" });
    expect(widget(r, "auth.entraMfaConditionalAccess").state).toBe("not_implemented");
    expect(value(r, "access.effectiveAssignments")).toBe(15);
    expect(value(r, "access.effectiveHolders")).toBe(4);
    expect(nonZero(value(r, "access.effectiveBySource"))).toEqual({ DIRECT: 14, LEGACY_ROLE: 1 });
    expect(value(r, "access.timeBoundVsPermanent")).toEqual({ TIME_BOUND: 1, PERMANENT: 14 });
    expect(nonZero(value(r, "access.administrativeEntitlementHolders"))).toEqual({ "assignments.manage": 1, "access_reviews.decide": 1 });
    expect(value(r, "access.nonActiveSubjectsWithEffectiveAccess")).toBe(1);
    expect(value(r, "access.expiringWithin7d")).toBe(1);
    expect(value(r, "access.activeRowsPastValidity")).toBe(1);
    expect(value(r, "access.effectiveLegacyRoleAssignments")).toBe(1);
    expect(nonZero(value(r, "resources.activeByType"))).toEqual({ API: 1, APPLICATION: 1 });
    expect(nonZero(value(r, "resources.activeScopesByKind"))).toEqual({ RESOURCE: 2 });
    expect(value(r, "resources.activeScopedEntitlements")).toBe(2);
    expect(value(r, "resources.withoutEffectiveHolder")).toBe(1);
    expect(value(r, "resources.providerBoundVsNative")).toEqual({ PROVIDER_BOUND: 1, NATIVE: 1 });
    expect(value(r, "governance.sodPoliciesByStatus")).toEqual({ ACTIVE: 1, DISABLED: 1 });
    expect(value(r, "governance.sodEnabledRules")).toBe(1);
    expect(value(r, "governance.sodDeniedAttempts30d")).toBe(1);
    expect(widget(r, "governance.sodExistingViolations").state).toBe("not_implemented");
    expect(value(r, "governance.reviewCampaignsByStatus")).toEqual({ OPEN: 1, COMPLETED: 1 });
    expect(value(r, "governance.overdueReviewCampaigns")).toBe(1);
    expect(value(r, "governance.pendingReviewItems")).toBe(1);
    expect(value(r, "governance.reviewItemsRequiringRemediation")).toBe(1);
    expect(value(r, "governance.myPendingReviewDecisions")).toBe(1);
    const activity = value(r, "activity.recentChangesAndDenials") as Array<{ operation: string; actorName: string; targetName: string | null }>;
    expect(activity.map(e => e.operation)).toEqual(["ASSIGNMENT.GRANT", "AUTHORIZATION.DENIED", "SESSION.REVOKE", "ASSIGNMENT.DENIED.SOD", "RESOURCE.CATALOG.UPDATE", "ASSIGNMENT.DENIED.SOD"]);
    expect(activity[0]).toMatchObject({ actorName: "Viewer V", targetName: "Subject One" });
    expect(value(r, "activity.deniedOrFailed24h")).toBe(1);
    expect(value(r, "activity.deniedOrFailed7d")).toBe(3);
    expect(value(r, "activity.privilegedChanges7d")).toBe(2);
    expect(r.attention.map(a => a.id).sort()).toEqual([
      "access.activeRowsPastValidity", "access.effectiveLegacyRoleAssignments", "access.expiringWithin7d", "access.nonActiveSubjectsWithEffectiveAccess",
      "auth.compromisedLocalAuthenticators", "auth.lockedLocalIdentities", "auth.pendingCredentialReenrollments",
      "governance.myPendingReviewDecisions", "governance.overdueReviewCampaigns", "governance.pendingReviewItems", "governance.reviewItemsRequiringRemediation",
      "identity.activeSubjectsWithoutActiveAccount", "identity.recoveryRequiredSubjects", "identity.unresolvedProviderCollisions"].sort());
  });

  it("no-rights viewer: every widget restricted, no value, no attention", async () => {
    const r = await loadIdentitySecurityPosture(auth(ids.N, acct.N), { now: new Date(now) });
    const all = Object.values(r.sections).flat();
    expect(all.every(w => w.state === "restricted")).toBe(true);
    expect(all.every(w => Object.keys(w).sort().join() === "id,state")).toBe(true);
    expect(r.attention).toEqual([]);
  });

  it("partial viewer (subjects.read only): governance and sessions hidden; restricted ≠ 0", async () => {
    const r = await loadIdentitySecurityPosture(auth(ids.L, acct.L), { now: new Date(now) });
    expect(widget(r, "identity.subjectsByLifecycle").state).toBe("ok");
    expect(widget(r, "identity.activeSubjectsWithoutActiveAccount").state).toBe("restricted");
    expect(widget(r, "access.nonActiveSubjectsWithEffectiveAccess").state).toBe("restricted");
    expect(r.sections.sessions.every(w => w.state === "restricted")).toBe(true);
    expect(r.sections.governance.every(w => w.state === "restricted")).toBe(true);
    expect(r.attention.map(a => a.id)).toEqual(["identity.recoveryRequiredSubjects"]);
  });

  it("tenant isolation: tenant B sees only its own data; tenant A counts exclude B", async () => {
    const rb = await loadIdentitySecurityPosture(auth(ids.vb, acct.vb, B), { now: new Date(now) });
    expect(nonZero(value(rb, "identity.subjectsByLifecycle"))).toEqual({ ACTIVE: 1 });
    expect(rb.sections.sessions.every(w => w.state === "restricted")).toBe(true);
    expect(rb.tenant.name).toBe("Posture tenant B");
  });

  it("privacy: payload carries no session id, ip/ua hash, credential id or external object id", async () => {
    const json = JSON.stringify(await loadIdentitySecurityPosture(auth(ids.V, acct.V), { now: new Date(now) }));
    for (const marker of Object.values(MARK)) expect(json).not.toContain(marker);
  });

  it("D1: one DASHBOARD.POSTURE.READ audit event per load; no other table changes", async () => {
    const before = await counts();
    const auditBefore = await withTenantDb(A, tx => tx.canonicalAdminAuditEvent.count({ where: { operation: POSTURE_AUDIT_OPERATION, actorSubjectId: ids.V } }));
    const totalBefore = await withTenantDb(A, tx => tx.canonicalAdminAuditEvent.count());
    await loadIdentitySecurityPosture(auth(ids.V, acct.V), { now: new Date(now) });
    expect(await counts()).toEqual(before);
    expect(await withTenantDb(A, tx => tx.canonicalAdminAuditEvent.count({ where: { operation: POSTURE_AUDIT_OPERATION, actorSubjectId: ids.V } }))).toBe(auditBefore + 1);
    expect(await withTenantDb(A, tx => tx.canonicalAdminAuditEvent.count())).toBe(totalBefore + 1);
  });

  it("unavailable is isolated per widget (thrown and SQL errors) and never rendered as 0", async () => {
    const r = await loadIdentitySecurityPosture(auth(ids.V, acct.V), { now: new Date(now), queries: {
      "sessions.active": async () => { throw new Error("boom"); },
      "sessions.activeSubjects": async q => { await q.tx.$queryRawUnsafe("SELECT 1/0"); return 0; },
    } });
    expect(widget(r, "sessions.active")).toEqual({ id: "sessions.active", state: "unavailable", reason: "QUERY_FAILED" });
    expect(widget(r, "sessions.activeSubjects")).toEqual({ id: "sessions.activeSubjects", state: "unavailable", reason: "QUERY_FAILED" });
    expect(value(r, "sessions.started24h")).toBe(3); // later widgets still served after a SQL error
    expect(JSON.stringify(r)).not.toContain("boom");
  });

  it("widget transaction is READ ONLY: an attempted write fails closed and persists nothing", async () => {
    const probe = randomUUID();
    const r = await loadIdentitySecurityPosture(auth(ids.V, acct.V), { now: new Date(now), queries: {
      "identity.recoveryRequiredSubjects": async q => { await q.tx.subject.create({ data: { ...A, id: probe, name: "must not persist", type: "HUMAN" } }); return 0; },
    } });
    expect(widget(r, "identity.recoveryRequiredSubjects").state).toBe("unavailable");
    expect(await withTenantDb(A, tx => tx.subject.count({ where: { id: probe } }))).toBe(0);
  });

  it("non-ACTIVE viewer is refused (403) and writes no audit event", async () => {
    const before = await withTenantDb(A, tx => tx.canonicalAdminAuditEvent.count({ where: { actorSubjectId: ids.s2 } }));
    await expect(loadIdentitySecurityPosture(auth(ids.s2, acct.s2))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(loadIdentitySecurityPosture(auth(ids.s2, acct.s2))).rejects.toBeInstanceOf(CanonicalAdminError);
    expect(await withTenantDb(A, tx => tx.canonicalAdminAuditEvent.count({ where: { actorSubjectId: ids.s2 } }))).toBe(before);
  });
});
