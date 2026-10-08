import { Prisma } from "@prisma/client";
import type { AuthContext } from "../auth/authorization-engine";
import { CanonicalAdminError } from "../admin/canonical-administration";
import { withTenantDb } from "../db/scoped-client";
import { requireNative } from "./service";
import { evaluateSoD } from "./sod";
import { isAssignmentEffective } from "../auth/entitlements-catalog";

const scope = (auth: AuthContext) => ({ organizationId: auth.organizationId, tenantId: auth.tenantId });
function fail(code: string, status = 409): never { throw new CanonicalAdminError(code, status); }
type Evidence = { campaignId?: string; itemId?: string; subjectId?: string; assignmentId?: string; entitlementId?: string; resourceId?: string | null; reviewerSubjectId?: string; decision?: string };
type Outcome<T> = { value: T } | { error: CanonicalAdminError };

/** All governance writers share this lock. Controlled DENY evidence commits before the outside throw. */
async function write<T>(auth: AuthContext, changeId: string, permission: string, operation: string,
  work: (tx: Prisma.TransactionClient, previous: boolean, evidence: Evidence) => Promise<{ value: T; replay?: boolean }>): Promise<T> {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(changeId)) fail("INVALID_CHANGE_ID", 400);
  const outcome = await withTenantDb<Outcome<T>>(auth, async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${auth.organizationId}:${auth.tenantId}`},0))::text`;
    const actor = await tx.subject.findFirst({ where: { ...scope(auth), id: auth.subjectId } });
    if (!actor) return { error: new CanonicalAdminError("FORBIDDEN", 403) };
    const prior = await tx.canonicalAdminAuditEvent.findFirst({ where: { ...scope(auth), changeId } });
    const evidence: Evidence = {};
    try {
      await requireNative(tx, auth, permission);
      if (prior && (prior.actorSubjectId !== auth.subjectId || prior.operation !== operation || prior.result !== "SUCCESS")) fail("CHANGE_ID_CONFLICT");
      const result = await work(tx, !!prior, evidence);
      if (prior && JSON.stringify(prior.metadata) !== JSON.stringify(JSON.parse(JSON.stringify(evidence)))) {
        // jsonb key order is not stable: compare the whitelisted fields individually.
        const data = prior.metadata as Record<string, unknown>;
        if (Object.keys(evidence).some(key => data[key] !== evidence[key as keyof Evidence]) || Object.keys(data).length !== Object.keys(evidence).length) fail("CHANGE_ID_CONFLICT");
      }
      if (!prior && !result.replay) await tx.canonicalAdminAuditEvent.create({ data: { ...scope(auth), actorSubjectId: auth.subjectId,
        targetSubjectId: evidence.subjectId, operation, changeId, result: "SUCCESS", assignmentIds: evidence.assignmentId ? [evidence.assignmentId] : [], metadata: { ...evidence } } });
      return { value: result.value };
    } catch (error) {
      if (!(error instanceof CanonicalAdminError)) throw error;
      if (!prior) await tx.canonicalAdminAuditEvent.create({ data: { ...scope(auth), actorSubjectId: auth.subjectId,
        operation: `${operation}.DENIED`, changeId, result: "DENIED", metadata: { ...evidence } } });
      return { error };
    }
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

async function scopeResources(tx: Prisma.TransactionClient, auth: AuthContext, scopeId: string) {
  const row = await tx.resourceScope.findFirst({ where: { ...scope(auth), id: scopeId, active: true }, include: { members: true } });
  if (!row) fail("NOT_FOUND", 404);
  const ids = row.kind === "RESOURCE" ? [row.resourceId!] : row.members.map(member => member.resourceId);
  const resources = await tx.resource.findMany({ where: { ...scope(auth), active: true, ...(row.kind === "TENANT" ? {} : { id: { in: ids } }) }, select: { id: true }, orderBy: { id: "asc" }, take: 1001 });
  if (resources.length > 1000) fail("REVIEW_SCOPE_TOO_LARGE", 400);
  return { row, ids: resources.map(resource => resource.id) };
}
export type CampaignInput = { name: string; scopeId: string; reviewerSubjectId: string; startsAt: Date; dueAt: Date };
export function createAccessReview(auth: AuthContext, input: CampaignInput, changeId: string) {
  return write(auth, changeId, "access_reviews.create", "ACCESS_REVIEW.CAMPAIGN.CREATE", async (tx, previous, evidence) => {
    if (previous) {
      const audit = await tx.canonicalAdminAuditEvent.findFirstOrThrow({ where: { ...scope(auth), changeId } });
      const id = (audit.metadata as { campaignId: string }).campaignId;
      const campaign = await tx.accessReviewCampaign.findFirstOrThrow({ where: { ...scope(auth), id } });
      if (campaign.name !== input.name.trim() || campaign.scopeId !== input.scopeId || campaign.reviewerSubjectId !== input.reviewerSubjectId || +campaign.startsAt !== +input.startsAt || +campaign.dueAt !== +input.dueAt) fail("CHANGE_ID_CONFLICT");
      evidence.campaignId = id;
      return { value: campaign, replay: true };
    }
    if (!input.name.trim() || input.name.trim().length > 120 || !Number.isFinite(+input.startsAt) || !Number.isFinite(+input.dueAt) || input.startsAt >= input.dueAt || input.dueAt <= new Date()) fail("INVALID_CAMPAIGN", 400);
    await requireNative(tx, { ...auth, subjectId: input.reviewerSubjectId }, "access_reviews.decide");
    const reviewer = await tx.subject.findFirst({ where: { ...scope(auth), id: input.reviewerSubjectId, type: "HUMAN", lifecycleState: "ACTIVE" } });
    if (!reviewer) fail("INVALID_REVIEWER", 403);
    const campaignScope = await scopeResources(tx, auth, input.scopeId);
    const now = new Date();
    const grants = await tx.assignment.findMany({ where: { ...scope(auth), status: "ACTIVE", source: { not: "LEGACY_ROLE" },
      OR: [{ validFrom: null }, { validFrom: { lte: now } }], AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: now } }] }],
      subject: { lifecycleState: "ACTIVE" }, entitlement: { active: true, resourceScopeId: { not: null } } }, include: { entitlement: true }, take: 1001, orderBy: { id: "asc" } });
    if (grants.length > 1000) fail("REVIEW_ASSIGNMENTS_TOO_LARGE", 400);
    const items = [];
    for (const grant of grants) {
      const grantScope = await scopeResources(tx, auth, grant.entitlement.resourceScopeId!);
      if (!grantScope.ids.some(id => campaignScope.ids.includes(id))) continue;
      if (grant.subjectId === reviewer.id) fail("SELF_REVIEW_FORBIDDEN", 403);
      items.push({ ...scope(auth), subjectId: grant.subjectId, assignmentId: grant.id, entitlementId: grant.entitlementId,
        scopeId: grantScope.row.id, resourceId: grantScope.row.kind === "RESOURCE" ? grantScope.row.resourceId : null,
        resourceIds: grantScope.ids, assignmentVersion: grant.updatedAt, entitlementVersion: grant.entitlement.updatedAt, reviewerSubjectId: reviewer.id });
    }
    const campaign = await tx.accessReviewCampaign.create({ data: { ...scope(auth), name: input.name.trim(), scopeId: campaignScope.row.id,
      scopeType: campaignScope.row.kind, resourceId: campaignScope.row.resourceId, reviewerSubjectId: reviewer.id, createdBySubjectId: auth.subjectId,
      startsAt: input.startsAt, dueAt: input.dueAt } });
    if (items.length) await tx.accessReviewItem.createMany({ data: items.map(item => ({ ...item, campaignId: campaign.id })) });
    evidence.campaignId = campaign.id;
    return { value: campaign };
  });
}
async function read<T>(auth: AuthContext, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withTenantDb(auth, async tx => { await requireNative(tx, auth, "access_reviews.read"); return work(tx); });
}
async function campaignInScope(tx: Prisma.TransactionClient, auth: AuthContext, id: string) {
  const campaign = await tx.accessReviewCampaign.findFirst({ where: { ...scope(auth), id } });
  if (!campaign) fail("NOT_FOUND", 404);
  return campaign;
}
export function listAccessReviews(auth: AuthContext, after?: string) {
  return read(auth, tx => tx.accessReviewCampaign.findMany({ where: { ...scope(auth), ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 100, include: { _count: { select: { items: true } } } }));
}
export function getAccessReview(auth: AuthContext, id: string) { return read(auth, tx => campaignInScope(tx, auth, id)); }
export function listReviewItems(auth: AuthContext, id: string, after?: string, pending = false) {
  return read(auth, async tx => { await campaignInScope(tx, auth, id); return tx.accessReviewItem.findMany({ where: { ...scope(auth), campaignId: id,
    ...(after ? { id: { gt: after } } : {}), ...(pending ? { decision: "PENDING", reviewerSubjectId: auth.subjectId } : {}) }, orderBy: { id: "asc" }, take: 100 }); });
}
export function reviewConfiguration(auth: AuthContext) {
  return withTenantDb(auth, async tx => {
    await requireNative(tx, auth, "access_reviews.create");
    const scopes = await tx.resourceScope.findMany({ where: { ...scope(auth), active: true }, orderBy: { id: "asc" }, take: 100 });
    const now = new Date();
    const reviewers = await tx.subject.findMany({ where: { ...scope(auth), type: "HUMAN", lifecycleState: "ACTIVE", Assignment: { some: {
      status: "ACTIVE", source: { not: "LEGACY_ROLE" }, OR: [{ validFrom: null }, { validFrom: { lte: now } }],
      AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: now } }] }], entitlement: { active: true, resourceScopeId: null, key: "access_reviews.decide" } } } },
      select: { id: true, name: true }, orderBy: { id: "asc" }, take: 100 });
    return { scopes, reviewers };
  });
}
export function decideReviewItem(auth: AuthContext, campaignId: string, itemId: string, input: { decision: "KEEP" | "REVOKE"; justification: string }, changeId: string) {
  return write(auth, changeId, "access_reviews.decide", `ACCESS_REVIEW.ITEM.${input.decision}`, async (tx, previous, evidence) => {
    const campaign = await campaignInScope(tx, auth, campaignId);
    const item = await tx.accessReviewItem.findFirst({ where: { ...scope(auth), id: itemId, campaignId } });
    if (!item) fail("NOT_FOUND", 404);
    if (item.reviewerSubjectId !== auth.subjectId || campaign.reviewerSubjectId !== auth.subjectId) fail("REVIEWER_NOT_AUTHORIZED", 403);
    if (item.subjectId === auth.subjectId) fail("SELF_REVIEW_FORBIDDEN", 403);
    const justification = input.justification.trim();
    if (justification.length < 3 || justification.length > 2000 || /Bearer\s|BEGIN .*PRIVATE KEY|client_secret|access_token|refresh_token/i.test(justification)) fail("INVALID_JUSTIFICATION", 400);
    Object.assign(evidence, { campaignId, itemId, subjectId: item.subjectId, assignmentId: item.assignmentId, entitlementId: item.entitlementId,
      resourceId: item.resourceId, reviewerSubjectId: auth.subjectId, decision: input.decision });
    if (item.decision !== "PENDING") {
      if (item.decision !== input.decision || item.justification !== justification) fail("REVIEW_DECISION_CONFLICT");
      return { value: item, replay: true };
    }
    if (previous) fail("CHANGE_ID_CONFLICT");
    const now = new Date();
    if (campaign.status !== "OPEN" || now < campaign.startsAt || now >= campaign.dueAt) fail("REVIEW_WINDOW_CLOSED");
    const assignment = await tx.assignment.findFirst({ where: { ...scope(auth), id: item.assignmentId }, include: { subject: true, entitlement: true } });
    if (!assignment) fail("REVIEW_ACCESS_CHANGED");
    const changed = assignment.subjectId !== item.subjectId || assignment.entitlementId !== item.entitlementId || assignment.source === "LEGACY_ROLE" || assignment.entitlement.resourceScopeId !== item.scopeId;
    let observed = assignment.status === "REVOKED" ? "REVOKED" : assignment.status === "EXPIRED" || (assignment.validUntil && assignment.validUntil <= now) ? "EXPIRED" : "ACTIVE";
    const remediate = async (code: string, state: string) => {
      await tx.accessReviewItem.update({ where: { id: item.id }, data: { reviewState: "REQUIRES_REMEDIATION", observedAssignmentState: state } });
      fail(code);
    };
    if (changed) await remediate("REVIEW_ACCESS_CHANGED", "CHANGED");
    // Do not revoke an access grant that was expanded/replaced after the snapshot.
    if (observed === "ACTIVE") {
      if (+assignment.updatedAt !== +item.assignmentVersion || +assignment.entitlement.updatedAt !== +item.entitlementVersion) await remediate("REVIEW_ACCESS_CHANGED", "CHANGED");
      const currentScope = await scopeResources(tx, auth, item.scopeId);
      if (JSON.stringify(currentScope.ids) !== JSON.stringify(item.resourceIds)) await remediate("REVIEW_ACCESS_CHANGED", "CHANGED");
    }
    if (input.decision === "KEEP") {
      if (!isAssignmentEffective(assignment, now) || assignment.subject.lifecycleState !== "ACTIVE" || !assignment.entitlement.active) await remediate("REVIEW_ACCESS_NOT_ACTIVE", observed === "ACTIVE" ? "INACTIVE" : observed);
      const sod = await evaluateSoD(tx, { ...scope(auth), subjectId: item.subjectId, entitlementId: item.entitlementId, scope: item.scopeId,
        assignmentOperation: "MODIFY", excludeAssignmentId: assignment.id, validFrom: assignment.validFrom ?? undefined, validUntil: assignment.validUntil ?? undefined });
      if (sod.decision === "DENY") await remediate("REQUIRES_REMEDIATION", "ACTIVE");
    } else if (observed === "ACTIVE") {
      await tx.assignment.update({ where: { organizationId_tenantId_id: { ...scope(auth), id: item.assignmentId } }, data: { status: "REVOKED" } });
      observed = "REVOKED";
    }
    const value = await tx.accessReviewItem.update({ where: { id: item.id }, data: { decision: input.decision, justification, decidedAt: now, reviewState: "DECIDED", observedAssignmentState: observed } });
    return { value };
  });
}
export function completeAccessReview(auth: AuthContext, id: string, changeId: string) {
  return write(auth, changeId, "access_reviews.manage", "ACCESS_REVIEW.CAMPAIGN.COMPLETE", async (tx, previous, evidence) => {
    const campaign = await campaignInScope(tx, auth, id); evidence.campaignId = id;
    if (campaign.status === "COMPLETED") return { value: campaign, replay: true };
    if (previous) fail("CHANGE_ID_CONFLICT");
    if (await tx.accessReviewItem.count({ where: { ...scope(auth), campaignId: id, decision: "PENDING" } })) fail("REVIEW_ITEMS_PENDING");
    return { value: await tx.accessReviewCampaign.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date() } }) };
  });
}
export function reviewAudit(auth: AuthContext, id: string, after?: string) {
  return read(auth, async tx => { await campaignInScope(tx, auth, id); return tx.canonicalAdminAuditEvent.findMany({ where: { ...scope(auth),
    operation: { startsWith: "ACCESS_REVIEW." }, metadata: { path: ["campaignId"], equals: id }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 100 }); });
}
