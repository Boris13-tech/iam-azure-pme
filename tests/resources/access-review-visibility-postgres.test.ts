// Access review campaign visibility (operator decision, #140):
//   access_reviews.read      the campaigns the caller reviews or created
//   access_reviews.read_all  every campaign of the tenant, read only: no decision, completion or creation
//   access_reviews.manage    unchanged capabilities, every campaign
// A campaign outside the caller's set behaves exactly like an id that does not exist, for reads and decisions, and
// a refused decision is journaled. Dashboard counters use the same set. app_user PostgreSQL with forced RLS.
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { loadIdentitySecurityPosture } from "../../lib/dashboard/posture";
import * as review from "../../lib/resources/access-reviews";

const context = { organizationId: randomUUID(), tenantId: randomUUID() };
const foreign = { organizationId: randomUUID(), tenantId: randomUUID() };
const as = (subjectId: string, scope = context) => ({ ...scope, subjectId });
const manager = as(randomUUID()), creator = as(randomUUID()), reviewer1 = as(randomUUID()), reviewer2 = as(randomUUID());
const reader = as(randomUUID()), auditor = as(randomUUID()), decider = as(randomUUID()), nobody = as(randomUUID());
const foreignAuditor = as(randomUUID(), foreign);
const alice = randomUUID(), bob = randomUUID();
const payroll = randomUUID(), crm = randomUUID(), payrollScope = randomUUID(), crmScope = randomUUID();
const change = () => `review-visibility-test:${randomUUID()}`;
let owner: PrismaClient;
let first: string, second: string;
const open = (auth: typeof manager, scopeId: string, reviewerSubjectId: string) => review.createAccessReview(auth, { name: "Visibility fixture", scopeId, reviewerSubjectId,
  startsAt: new Date(Date.now() - 60000), dueAt: new Date(Date.now() + 3600000) }, change());
const ids = (rows: { id: string }[]) => rows.map(row => row.id).sort();
const keep = (auth: typeof manager, campaignId: string, itemId: string, changeId = change()) =>
  review.decideReviewItem(auth, campaignId, itemId, { decision: "KEEP", justification: "Still needed" }, changeId);
/** The whole observable failure: class, code, HTTP status and message. */
const failure = async (work: () => Promise<unknown>) => {
  try { await work(); } catch (error) { const e = error as { name: string; code: string; httpStatus: number; message: string };
    return { name: e.name, code: e.code, httpStatus: e.httpStatus, message: e.message }; }
  throw new Error("EXPECTED_FAILURE");
};
const evidence = (changeId: string) => withTenantDb(manager, tx => tx.canonicalAdminAuditEvent.findFirst({ where: { ...context, changeId } }));
const posture = (auth: typeof manager) => loadIdentitySecurityPosture({ ...auth, sessionId: randomUUID(), identityAccountId: randomUUID() });
const counters = async (auth: typeof manager) => {
  const widgets = Object.fromEntries((await posture(auth)).sections.governance.map(w => [w.id, w]));
  const value = (id: string) => widgets[id].state === "ok" ? (widgets[id] as { value: unknown }).value : widgets[id].state;
  return { byStatus: value("governance.reviewCampaignsByStatus"), overdue: value("governance.overdueReviewCampaigns"),
    pending: value("governance.pendingReviewItems"), remediation: value("governance.reviewItemsRequiringRemediation"), mine: value("governance.myPendingReviewDecisions") };
};

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("Access review campaign visibility and read_all (app_user PostgreSQL/RLS)", () => {
  beforeAll(async () => {
    // Both connections write: each must be a local database with a test name.
    for (const raw of [process.env.DATABASE_URL, process.env.DATABASE_MIGRATION_URL]) {
      if (!raw || !["localhost", "127.0.0.1"].includes(new URL(raw).hostname) || !/^\/luxia_\w+$/.test(new URL(raw).pathname)) throw new Error("ISOLATED_DB_REQUIRED");
    }
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${context.organizationId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${context.tenantId}, true)`;
      await tx.organization.create({ data: { id: context.organizationId, name: "Review visibility fixture" } });
      await tx.tenant.create({ data: { id: context.tenantId, organizationId: context.organizationId, name: "Review visibility fixture" } });
      for (const [id, name] of [[manager.subjectId, "Manager"], [creator.subjectId, "Creator"], [reviewer1.subjectId, "Reviewer one"],
        [reviewer2.subjectId, "Reviewer two"], [reader.subjectId, "Reader"], [auditor.subjectId, "Auditor"], [decider.subjectId, "Decider"],
        [nobody.subjectId, "Nobody"], [alice, "Alice"], [bob, "Bob"]])
        await tx.subject.create({ data: { ...context, id, type: "HUMAN", name } });
      for (const [id, scopeId, name] of [[payroll, payrollScope, "Payroll"], [crm, crmScope, "CRM"]]) {
        await tx.resource.create({ data: { ...context, id, type: "API", name } });
        await tx.resourceScope.create({ data: { ...context, id: scopeId, key: `visibility-${name}`, kind: "RESOURCE", resourceId: id } });
      }
      for (const [subjectId, resourceScopeId, key] of [[alice, payrollScope, "payroll.read"], [bob, crmScope, "crm.read"]]) {
        const entitlement = await tx.entitlement.create({ data: { ...context, key, action: "read", resource: "resource-scope", resourceScopeId } });
        await tx.assignment.create({ data: { ...context, subjectId, entitlementId: entitlement.id, source: "DIRECT", sourceRef: randomUUID() } });
      }
      const rights: Array<[string, string[]]> = [
        ["access_reviews.read", [manager, creator, reviewer1, reviewer2, reader].map(auth => auth.subjectId)],
        ["access_reviews.read_all", [auditor.subjectId]],
        ["access_reviews.create", [manager.subjectId, creator.subjectId]], ["access_reviews.manage", [manager.subjectId]],
        ["access_reviews.decide", [reviewer1.subjectId, reviewer2.subjectId, decider.subjectId]]];
      for (const [key, subjectIds] of rights) {
        const entitlement = await tx.entitlement.create({ data: { ...context, key, action: key.split(".")[1], resource: "access_reviews" } });
        for (const subjectId of subjectIds) await tx.assignment.create({ data: { ...context, subjectId, entitlementId: entitlement.id, source: "DIRECT" } });
      }
    }, { timeout: 120000 });
    await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${foreign.organizationId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${foreign.tenantId}, true)`;
      await tx.organization.create({ data: { id: foreign.organizationId, name: "Review visibility foreign" } });
      await tx.tenant.create({ data: { id: foreign.tenantId, organizationId: foreign.organizationId, name: "Review visibility foreign" } });
      await tx.subject.create({ data: { ...foreign, id: foreignAuditor.subjectId, type: "HUMAN", name: "Foreign auditor" } });
      const entitlement = await tx.entitlement.create({ data: { ...foreign, key: "access_reviews.read_all", action: "read_all", resource: "access_reviews" } });
      await tx.assignment.create({ data: { ...foreign, subjectId: foreignAuditor.subjectId, entitlementId: entitlement.id, source: "DIRECT" } });
    }, { timeout: 120000 });
    first = (await open(manager, payrollScope, reviewer1.subjectId)).id;
    second = (await open(creator, crmScope, reviewer2.subjectId)).id;
  }, 180000);
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });

  it("6. dashboard counters cover exactly the campaigns the viewer can open", async () => {
    // Before any decision: one open campaign with one pending item each.
    expect(await counters(reviewer1)).toEqual({ byStatus: { OPEN: 1, COMPLETED: 0 }, overdue: 0, pending: 1, remediation: 0, mine: 1 });
    expect(await counters(creator)).toEqual({ byStatus: { OPEN: 1, COMPLETED: 0 }, overdue: 0, pending: 1, remediation: 0, mine: "restricted" });
    expect(await counters(reader)).toEqual({ byStatus: { OPEN: 0, COMPLETED: 0 }, overdue: 0, pending: 0, remediation: 0, mine: "restricted" });
    for (const global of [auditor, manager]) expect((await counters(global)).byStatus).toEqual({ OPEN: 2, COMPLETED: 0 });
    expect((await counters(auditor)).pending).toBe(2);
    // No read right at all: no access review counter, even with decide.
    for (const none of [decider, nobody]) expect(await counters(none)).toEqual({ byStatus: "restricted", overdue: "restricted", pending: "restricted", remediation: "restricted", mine: "restricted" });
    // read_all is per tenant: another organization's auditor counts nothing here.
    expect((await counters(foreignAuditor)).byStatus).toEqual({ OPEN: 0, COMPLETED: 0 });
  });

  it("1 and 7. read does not open a campaign one neither reviews nor created: every read is NOT_FOUND", async () => {
    expect(ids(await review.listAccessReviews(reviewer1))).toEqual([first]);
    expect(ids(await review.listAccessReviews(reviewer2))).toEqual([second]);
    expect(ids(await review.listAccessReviews(creator))).toEqual([second]);
    expect(await review.listAccessReviews(reader)).toEqual([]);
    for (const [auth, id] of [[reviewer1, second], [reviewer2, first], [creator, first], [reader, first]] as const)
      for (const read of [() => review.getAccessReview(auth, id), () => review.listReviewItems(auth, id), () => review.listReviewItems(auth, id, undefined, true), () => review.reviewAudit(auth, id)])
        await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });

  it("2. read_all reads every campaign of its tenant, and nothing of another organization", async () => {
    expect(ids(await review.listAccessReviews(auditor))).toEqual([first, second].sort());
    for (const id of [first, second]) {
      expect((await review.getAccessReview(auditor, id)).id).toBe(id);
      expect(await review.listReviewItems(auditor, id)).toHaveLength(1);
      expect(Array.isArray(await review.reviewAudit(auditor, id))).toBe(true);
    }
    expect(await review.listAccessReviews(foreignAuditor)).toEqual([]);
    await expect(review.getAccessReview(foreignAuditor, first)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("3 and 4. read_all alone cannot decide, complete or create, and nothing changes", async () => {
    const item = (await review.listReviewItems(auditor, second))[0];
    await expect(keep(auditor, second, item.id)).rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
    await expect(review.decideReviewItem(auditor, second, item.id, { decision: "REVOKE", justification: "Auditor tries" }, change())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(review.completeAccessReview(auditor, second, change())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(open(auditor, payrollScope, reviewer1.subjectId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(review.reviewConfiguration(auditor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await review.listReviewItems(manager, second))[0].decision).toBe("PENDING");
    expect((await review.getAccessReview(manager, second)).status).toBe("OPEN");
  });

  it("5. manage keeps its behaviour: sees every campaign and reaches completion rules on any of them", async () => {
    expect(ids(await review.listAccessReviews(manager))).toEqual([first, second].sort());
    // Completion is refused for pending items, not hidden: manage reaches the campaign it did not create or review.
    await expect(review.completeAccessReview(manager, second, change())).rejects.toMatchObject({ code: "REVIEW_ITEMS_PENDING" });
  });

  it("8 and 9. an out-of-scope campaign and an unknown id are indistinguishable, and both refused decisions are journaled alike", async () => {
    const outOfScope = (await review.listReviewItems(manager, second))[0];
    const unknownCampaign = randomUUID(), unknownItem = randomUUID();
    for (const [name, real, missing] of [
      ["get", () => review.getAccessReview(reviewer1, second), () => review.getAccessReview(reviewer1, unknownCampaign)],
      ["items", () => review.listReviewItems(reviewer1, second), () => review.listReviewItems(reviewer1, unknownCampaign)],
      ["audit", () => review.reviewAudit(reviewer1, second), () => review.reviewAudit(reviewer1, unknownCampaign)],
    ] as const) expect(await failure(real), name).toEqual(await failure(missing));
    const realChange = change(), missingChange = change();
    const decided = await failure(() => keep(reviewer1, second, outOfScope.id, realChange));
    expect(decided).toEqual(await failure(() => keep(reviewer1, unknownCampaign, unknownItem, missingChange)));
    expect(decided).toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    const [real, missing] = [await evidence(realChange), await evidence(missingChange)];
    const shape = (row: typeof real) => ({ operation: row?.operation, result: row?.result, actor: row?.actorSubjectId, target: row?.targetSubjectId, assignmentIds: row?.assignmentIds, metadata: row?.metadata });
    expect(shape(real)).toEqual({ operation: "ACCESS_REVIEW.ITEM.KEEP.DENIED", result: "DENIED", actor: reviewer1.subjectId, target: null, assignmentIds: [], metadata: {} });
    expect(shape(missing)).toEqual(shape(real));
    expect((await review.listReviewItems(manager, second))[0].decision).toBe("PENDING");
  });

  it("6b. with hidden campaigns that would count, a limited reader's every counter differs from the tenant's", async () => {
    // Its own tenant: every count below is exact, and each is nonzero on both sides.
    const scope = { organizationId: randomUUID(), tenantId: randomUUID() };
    const limited = as(randomUUID(), scope), other = as(randomUUID(), scope), wide = as(randomUUID(), scope), managing = as(randomUUID(), scope);
    await owner.organization.create({ data: { id: scope.organizationId, name: "Review counters fixture" } });
    await owner.tenant.create({ data: { id: scope.tenantId, organizationId: scope.organizationId, name: "Review counters fixture" } });
    for (const auth of [limited, other, wide, managing]) await owner.subject.create({ data: { ...scope, id: auth.subjectId, type: "HUMAN", name: "Counters" } });
    const rights: Array<[string, string[]]> = [
      ["access_reviews.read", [limited.subjectId, managing.subjectId]], ["access_reviews.decide", [limited.subjectId]],
      ["access_reviews.read_all", [wide.subjectId]], ["access_reviews.manage", [managing.subjectId]]];
    for (const [key, subjectIds] of rights) {
      const entitlement = await owner.entitlement.create({ data: { ...scope, key, action: key.split(".")[1], resource: "access_reviews" } });
      for (const subjectId of subjectIds) await owner.assignment.create({ data: { ...scope, subjectId, entitlementId: entitlement.id, source: "DIRECT" } });
    }
    const past = new Date(Date.now() - 86_400_000);
    // Real references: the backup round trip restores this database, foreign keys included.
    const reviewedScope = await owner.resourceScope.create({ data: { ...scope, key: "counters", kind: "TENANT" } });
    const reviewed = await owner.entitlement.create({ data: { ...scope, key: "counters.review", action: "review", resource: "counters" } });
    await owner.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      const campaign = (reviewerSubjectId: string, status: "OPEN" | "COMPLETED") => tx.accessReviewCampaign.create({ data: { ...scope, name: "Counters", scopeId: reviewedScope.id, scopeType: "TENANT",
        reviewerSubjectId, createdBySubjectId: other.subjectId, startsAt: new Date(past.getTime() - 86_400_000), dueAt: past, status, completedAt: status === "COMPLETED" ? past : null } });
      const item = async (campaignId: string, reviewerSubjectId: string, reviewState: "PENDING" | "REQUIRES_REMEDIATION") => {
        const assignment = await tx.assignment.create({ data: { ...scope, subjectId: managing.subjectId, entitlementId: reviewed.id, source: "DIRECT", sourceRef: randomUUID() } });
        await tx.accessReviewItem.create({ data: { ...scope, campaignId, reviewerSubjectId, reviewState,
          subjectId: managing.subjectId, assignmentId: assignment.id, entitlementId: reviewed.id, scopeId: reviewedScope.id, resourceIds: [randomUUID()], assignmentVersion: past, entitlementVersion: past } });
      };
      // Visible to the limited reader: one overdue campaign, one pending item, one to remediate.
      const own = await campaign(limited.subjectId, "OPEN");
      await item(own.id, limited.subjectId, "PENDING");
      await item(own.id, limited.subjectId, "REQUIRES_REMEDIATION");
      // Hidden from it: two more overdue campaigns, one completed, and their items.
      for (const status of ["OPEN", "OPEN", "COMPLETED"] as const) {
        const hidden = await campaign(other.subjectId, status);
        await item(hidden.id, other.subjectId, "PENDING");
        await item(hidden.id, other.subjectId, "REQUIRES_REMEDIATION");
      }
    }, { timeout: 30_000 });
    expect(await counters(limited)).toEqual({ byStatus: { OPEN: 1, COMPLETED: 0 }, overdue: 1, pending: 1, remediation: 1, mine: 2 });
    const tenantWide = { byStatus: { OPEN: 3, COMPLETED: 1 }, overdue: 3, pending: 3, remediation: 4, mine: "restricted" };
    expect(await counters(wide)).toEqual(tenantWide);
    expect(await counters(managing)).toEqual(tenantWide);
  });

  it("a reviewer still decides on their own campaign", async () => {
    const own = (await review.listReviewItems(reviewer1, first))[0];
    expect((await keep(reviewer1, first, own.id)).decision).toBe("KEEP");
    expect((await counters(reviewer1)).mine).toBe(0);
  });
});
