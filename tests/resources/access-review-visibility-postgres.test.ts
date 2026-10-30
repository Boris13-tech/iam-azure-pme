// Access review campaign visibility: access_reviews.manage sees every campaign of the tenant; anyone else sees only
// the campaigns they review or created. Another campaign is NOT_FOUND for every read and for a decision, and the
// refused decision leaves DENIED evidence. app_user PostgreSQL with forced RLS.
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import * as review from "../../lib/resources/access-reviews";

const context = { organizationId: randomUUID(), tenantId: randomUUID() };
const as = (subjectId: string) => ({ ...context, subjectId });
const manager = as(randomUUID()), creator = as(randomUUID()), reviewer1 = as(randomUUID()), reviewer2 = as(randomUUID()), reader = as(randomUUID());
const alice = randomUUID(), bob = randomUUID();
const payroll = randomUUID(), crm = randomUUID(), payrollScope = randomUUID(), crmScope = randomUUID();
const change = () => `review-visibility-test:${randomUUID()}`;
let owner: PrismaClient;
let first: string, second: string;
const open = (auth: typeof manager, scopeId: string, reviewerSubjectId: string) => review.createAccessReview(auth, { name: "Visibility fixture", scopeId, reviewerSubjectId,
  startsAt: new Date(Date.now() - 60000), dueAt: new Date(Date.now() + 3600000) }, change());
const ids = (rows: { id: string }[]) => rows.map(row => row.id).sort();

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("Access review campaign visibility (app_user PostgreSQL/RLS)", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${context.organizationId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${context.tenantId}, true)`;
      await tx.organization.create({ data: { id: context.organizationId, name: "Review visibility fixture" } });
      await tx.tenant.create({ data: { id: context.tenantId, organizationId: context.organizationId, name: "Review visibility fixture" } });
      for (const [id, name] of [[manager.subjectId, "Manager"], [creator.subjectId, "Creator"], [reviewer1.subjectId, "Reviewer one"],
        [reviewer2.subjectId, "Reviewer two"], [reader.subjectId, "Reader"], [alice, "Alice"], [bob, "Bob"]])
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
        ["access_reviews.create", [manager.subjectId, creator.subjectId]], ["access_reviews.manage", [manager.subjectId]],
        ["access_reviews.decide", [reviewer1.subjectId, reviewer2.subjectId]]];
      for (const [key, subjectIds] of rights) {
        const entitlement = await tx.entitlement.create({ data: { ...context, key, action: key.split(".")[1], resource: "access_reviews" } });
        for (const subjectId of subjectIds) await tx.assignment.create({ data: { ...context, subjectId, entitlementId: entitlement.id, source: "DIRECT" } });
      }
    }, { timeout: 120000 });
    first = (await open(manager, payrollScope, reviewer1.subjectId)).id;
    second = (await open(creator, crmScope, reviewer2.subjectId)).id;
  }, 180000);
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });

  it("access_reviews.manage sees every campaign of the tenant", async () => {
    expect(ids(await review.listAccessReviews(manager))).toEqual([first, second].sort());
    for (const id of [first, second]) {
      expect((await review.getAccessReview(manager, id)).id).toBe(id);
      expect(await review.listReviewItems(manager, id)).toHaveLength(1);
    }
  });

  it("a reviewer sees only the campaign they review: every read of another one is NOT_FOUND", async () => {
    expect(ids(await review.listAccessReviews(reviewer1))).toEqual([first]);
    expect(ids(await review.listAccessReviews(reviewer2))).toEqual([second]);
    expect((await review.listReviewItems(reviewer1, first))[0].subjectId).toBe(alice);
    for (const read of [() => review.getAccessReview(reviewer1, second), () => review.listReviewItems(reviewer1, second),
      () => review.listReviewItems(reviewer1, second, undefined, true), () => review.reviewAudit(reviewer1, second)])
      await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a creator without manage sees the campaign they created, and not the others", async () => {
    expect(ids(await review.listAccessReviews(creator))).toEqual([second]);
    expect((await review.getAccessReview(creator, second)).id).toBe(second);
    await expect(review.getAccessReview(creator, first)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("access_reviews.read alone, without reviewing or creating, sees no campaign", async () => {
    expect(await review.listAccessReviews(reader)).toEqual([]);
    await expect(review.getAccessReview(reader, first)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(review.listReviewItems(reader, first)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a decision on another reviewer's campaign is NOT_FOUND with DENIED evidence; on one's own it succeeds", async () => {
    const foreignItem = (await review.listReviewItems(manager, second))[0], changeId = change();
    await expect(review.decideReviewItem(reviewer1, second, foreignItem.id, { decision: "KEEP", justification: "Not my campaign" }, changeId))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const evidence = await withTenantDb(manager, tx => tx.canonicalAdminAuditEvent.findFirstOrThrow({ where: { ...context, changeId } }));
    expect(evidence).toMatchObject({ result: "DENIED", operation: "ACCESS_REVIEW.ITEM.KEEP.DENIED", actorSubjectId: reviewer1.subjectId });
    expect((await review.listReviewItems(manager, second))[0].decision).toBe("PENDING");
    const own = (await review.listReviewItems(reviewer1, first))[0];
    expect((await review.decideReviewItem(reviewer1, first, own.id, { decision: "KEEP", justification: "Still needed for payroll" }, change())).decision).toBe("KEEP");
  });
});
