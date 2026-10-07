import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import { rawPrisma } from "../../lib/db/raw-prisma";
import * as review from "../../lib/resources/access-reviews";

const auth = { organizationId: randomUUID(), tenantId: randomUUID(), subjectId: randomUUID() };
const reviewer = { ...auth, subjectId: randomUUID() };
const foreignReviewer = { ...auth, tenantId: randomUUID(), subjectId: randomUUID() };
const context = { organizationId: auth.organizationId, tenantId: auth.tenantId };
const target = randomUUID(), resourceId = randomUUID(), scopeId = randomUUID(), entitlementId = randomUUID();
const change = () => `review-test:${randomUUID()}`;
let owner: PrismaClient;
let assignmentId: string;
let legacyBefore: unknown;
let subjectsBefore: unknown;
const identities = () => withTenantDb(auth, async tx => ({ subjects: await tx.subject.findMany({ where: context, orderBy: { id: "asc" } }), accounts: await tx.identityAccount.findMany({ where: context, orderBy: { id: "asc" } }) }));
const legacyDigest = async () => owner.$queryRawUnsafe(`SELECT md5(string_agg(row_text,'|' ORDER BY row_text)) digest FROM (
 SELECT row_to_json(t)::text row_text FROM "User" t UNION ALL SELECT row_to_json(t)::text FROM "Role" t
 UNION ALL SELECT row_to_json(t)::text FROM "Permission" t UNION ALL SELECT row_to_json(t)::text FROM "UserRole" t
 UNION ALL SELECT row_to_json(t)::text FROM "AccessPolicy" t UNION ALL SELECT row_to_json(t)::text FROM "AuditLog" t
 UNION ALL SELECT row_to_json(t)::text FROM "LegacyUserBridge" t) rows`);
const campaign = () => review.createAccessReview(auth, { name: "Review fixture", scopeId, reviewerSubjectId: reviewer.subjectId,
  startsAt: new Date(Date.now() - 60000), dueAt: new Date(Date.now() + 3600000) }, change());
const grant = () => withTenantDb(auth, tx => tx.assignment.create({ data: { ...context, subjectId: target, entitlementId, source: "DIRECT", sourceRef: randomUUID(), validUntil: new Date(Date.now() + 3600000) } }));
const decide = (campaignId: string, itemId: string, decision: "KEEP" | "REVOKE", id = change()) => review.decideReviewItem(reviewer, campaignId, itemId, { decision, justification: "Explicit certification decision" }, id);

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("Access Reviews real app_user PostgreSQL/RLS", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!(["localhost", "127.0.0.1"].includes(url.hostname) || (["ep-dark-king-ah402c68-pooler.c-3.us-east-1.aws.neon.tech", "ep-holy-forest-ah3ser8s-pooler.c-3.us-east-1.aws.neon.tech"].includes(url.hostname) && url.pathname === "/luxia_reviews_cert"))) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    legacyBefore = await legacyDigest();
    await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${auth.organizationId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${auth.tenantId}, true)`;
      await tx.organization.create({ data: { id: auth.organizationId, name: "Isolated review fixture" } });
      await tx.tenant.create({ data: { id: auth.tenantId, organizationId: auth.organizationId, name: "Review fixture" } });
      for (const id of [auth.subjectId, reviewer.subjectId, target]) await tx.subject.create({ data: { ...context, id, type: "HUMAN", name: "Certification fixture" } });
      await tx.resource.create({ data: { ...context, id: resourceId, type: "API", name: "Review test API" } });
      await tx.resourceScope.create({ data: { ...context, id: scopeId, key: "review-resource", kind: "RESOURCE", resourceId } });
      await tx.entitlement.create({ data: { ...context, id: entitlementId, key: "review.resource.read", action: "read", resource: "resource-scope", resourceScopeId: scopeId } });
      for (const key of ["access_reviews.read", "access_reviews.create", "access_reviews.decide", "access_reviews.manage"]) {
        const entitlement = await tx.entitlement.create({ data: { ...context, key, action: key.split(".")[1], resource: "access_reviews" } });
        for (const subjectId of [auth.subjectId, reviewer.subjectId]) await tx.assignment.create({ data: { ...context, subjectId, entitlementId: entitlement.id, source: "DIRECT" } });
      }
      await tx.tenant.create({ data: { organizationId: auth.organizationId, id: foreignReviewer.tenantId, name: "Other review tenant fixture" } });
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${foreignReviewer.tenantId}, true)`;
      await tx.subject.create({ data: { organizationId: auth.organizationId, tenantId: foreignReviewer.tenantId, id: foreignReviewer.subjectId, name: "Foreign reviewer fixture", type: "HUMAN" } });
      for (const key of ["access_reviews.read", "access_reviews.decide"]) {
        const entitlement = await tx.entitlement.create({ data: { organizationId: auth.organizationId, tenantId: foreignReviewer.tenantId, key, action: key.split(".")[1], resource: "access_reviews" } });
        await tx.assignment.create({ data: { organizationId: auth.organizationId, tenantId: foreignReviewer.tenantId, subjectId: foreignReviewer.subjectId, entitlementId: entitlement.id, source: "DIRECT" } });
      }
    }, { timeout: 120000 });
    assignmentId = (await grant()).id;
    subjectsBefore = await identities();
  }, 120000);
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });
  it("forced RLS / NOSUPERUSER / NOBYPASSRLS / no table ownership", async () => {
    const tables = await withTenantDb(auth, tx => tx.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean; owner: boolean }>>`SELECT relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner FROM pg_class WHERE relname IN ('AccessReviewCampaign','AccessReviewItem')`);
    expect(tables).toHaveLength(2); expect(tables.every(row => row.relrowsecurity && row.relforcerowsecurity && !row.owner)).toBe(true);
    const roles = await withTenantDb(auth, tx => tx.$queryRaw<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>>`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    expect(roles[0]).toEqual({ current_user: "app_user", rolsuper: false, rolbypassrls: false });
    const constraints = await withTenantDb(auth, tx => tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) n FROM pg_constraint WHERE contype='f' AND conrelid IN ('"AccessReviewCampaign"'::regclass,'"AccessReviewItem"'::regclass)`);
    expect(Number(constraints[0].n)).toBe(10);
  });
  it("actual active assignments only; KEEP unchanged; complete and replay are idempotent", async () => {
    const revoked = await grant(); const expired = await grant();
    await withTenantDb(auth, async tx => {
      await tx.assignment.update({ where: { id: revoked.id }, data: { status: "REVOKED" } });
      await tx.assignment.update({ where: { id: expired.id }, data: { validUntil: new Date(Date.now() - 1000) } });
    });
    const c = await campaign(), items = await review.listReviewItems(auth, c.id);
    expect(items.map(row => row.assignmentId)).toEqual([assignmentId]);
    const before = await withTenantDb(auth, tx => tx.assignment.findUniqueOrThrow({ where: { id: assignmentId } }));
    const id = change(), result = await decide(c.id, items[0].id, "KEEP", id);
    expect(await decide(c.id, items[0].id, "KEEP", id)).toEqual(result);
    expect(await decide(c.id, items[0].id, "KEEP")).toEqual(result);
    expect(await withTenantDb(auth, tx => tx.assignment.findUnique({ where: { id: assignmentId } }))).toEqual(before);
    await expect(decide(c.id, items[0].id, "REVOKE")).rejects.toMatchObject({ code: "REVIEW_DECISION_CONFLICT" });
    expect((await review.completeAccessReview(auth, c.id, change())).status).toBe("COMPLETED");
    await review.completeAccessReview(auth, c.id, change());
    const audits = await review.reviewAudit(auth, c.id);
    expect(audits.filter(row => row.operation === "ACCESS_REVIEW.ITEM.KEEP")).toHaveLength(1);
    expect(audits.filter(row => row.operation === "ACCESS_REVIEW.CAMPAIGN.COMPLETE")).toHaveLength(1);
  });
  it("REVOKE atomic/idempotent; audit safe whitelist; no recreation", async () => {
    const c = await campaign(), item = (await review.listReviewItems(auth, c.id))[0];
    const first = await decide(c.id, item.id, "REVOKE");
    expect(await decide(c.id, item.id, "REVOKE")).toEqual(first);
    await withTenantDb(auth, async tx => {
      expect((await tx.assignment.findUniqueOrThrow({ where: { id: item.assignmentId } })).status).toBe("REVOKED");
      const audits = await tx.canonicalAdminAuditEvent.findMany({ where: { ...context, operation: "ACCESS_REVIEW.ITEM.REVOKE", metadata: { path: ["itemId"], equals: item.id } } });
      expect(audits).toHaveLength(1); expect(audits[0].result).toBe("SUCCESS");
      expect(Object.keys(audits[0].metadata as object).sort()).toEqual(["campaignId","itemId","subjectId","assignmentId","entitlementId","resourceId","reviewerSubjectId","decision"].sort());
    });
  });
  it("revoked or expired since snapshot: KEEP denied, REVOKE never recreates", async () => {
    for (const state of ["REVOKED", "EXPIRED"] as const) {
      const a = await grant(), c = await campaign(), item = (await review.listReviewItems(auth, c.id)).find(row => row.assignmentId === a.id)!;
      await withTenantDb(auth, tx => tx.assignment.update({ where: { id: a.id }, data: state === "REVOKED" ? { status: "REVOKED" } : { validUntil: new Date(Date.now() - 1000) } }));
      await expect(decide(c.id, item.id, "KEEP")).rejects.toMatchObject({ code: "REVIEW_ACCESS_NOT_ACTIVE" });
      await decide(c.id, item.id, "REVOKE");
      expect(await withTenantDb(auth, tx => tx.assignment.count({ where: { id: a.id, status: "ACTIVE", validUntil: { gt: new Date() } } }))).toBe(0);
    }
  });
  it("unauthorized/unassigned reviewer, foreign tenant/campaign and self-review DENY", async () => {
    await grant(); const c = await campaign(), item = (await review.listReviewItems(auth, c.id))[0];
    await expect(review.decideReviewItem(auth, c.id, item.id, { decision: "KEEP", justification: "Not my review" }, change())).rejects.toMatchObject({ code: "REVIEWER_NOT_AUTHORIZED" });
    await expect(review.decideReviewItem({ ...auth, subjectId: target }, c.id, item.id, { decision: "KEEP", justification: "Self review" }, change())).rejects.toMatchObject({ code: "FORBIDDEN" });
    const foreign = foreignReviewer;
    expect(await withTenantDb(foreign, tx => tx.accessReviewCampaign.count())).toBe(0);
    expect(await withTenantDb(foreign, tx => tx.accessReviewItem.count())).toBe(0);
    expect(await withTenantDb(foreign, tx => tx.canonicalAdminAuditEvent.count())).toBe(0);
    await expect(review.getAccessReview(foreign, c.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(review.decideReviewItem(foreign, c.id, item.id, { decision: "KEEP", justification: "Foreign reviewer" }, change())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(review.createAccessReview(auth, { name: "Wrong tenant reviewer", scopeId, reviewerSubjectId: foreign.subjectId, startsAt: new Date(), dueAt: new Date(Date.now() + 3600000) }, change())).rejects.toMatchObject({ code: "FORBIDDEN" });
    const self = await withTenantDb(auth, tx => tx.assignment.create({ data: { ...context, subjectId: reviewer.subjectId, entitlementId, source: "DIRECT" } }));
    await expect(campaign()).rejects.toMatchObject({ code: "SELF_REVIEW_FORBIDDEN" });
    await withTenantDb(auth, tx => tx.assignment.update({ where: { id: self.id }, data: { status: "REVOKED" } }));
    await expect(withTenantDb(foreign, tx => tx.accessReviewCampaign.create({ data: { ...context, name: "Foreign", scopeId, scopeType: "RESOURCE", resourceId, reviewerSubjectId: reviewer.subjectId, createdBySubjectId: auth.subjectId, startsAt: new Date(), dueAt: new Date(Date.now() + 60000) } }))).rejects.toBeDefined();
  });
  it("stale scope/assignment changes cannot be confirmed; pending campaign cannot complete", async () => {
    const c = await campaign(), item = (await review.listReviewItems(auth, c.id))[0];
    await withTenantDb(auth, tx => tx.assignment.update({ where: { id: item.assignmentId }, data: { validUntil: new Date(Date.now() + 7200000) } }));
    await expect(decide(c.id, item.id, "KEEP")).rejects.toMatchObject({ code: "REVIEW_ACCESS_CHANGED" });
    expect((await review.listReviewItems(auth, c.id)).find(row => row.id === item.id)?.reviewState).toBe("REQUIRES_REMEDIATION");
    await expect(review.completeAccessReview(auth, c.id, change())).rejects.toMatchObject({ code: "REVIEW_ITEMS_PENDING" });
    await expect(withTenantDb(auth, tx => tx.accessReviewItem.update({ where: { id: item.id }, data: { entitlementId: randomUUID() } }))).rejects.toBeDefined();
  });
  it("KEEP detects newly active SoD policy; commits remediation and DENIED evidence", async () => {
    // Existing production service rejects activation over conflicts. Simulate imported historical
    // inconsistent state solely in this isolated fixture to exercise defense-in-depth KEEP.
    const c = await campaign(), item = (await review.listReviewItems(auth, c.id))[0];
    const other = await withTenantDb(auth, tx => tx.entitlement.create({ data: { ...context, key: "review.approve", action: "approve", resource: "resource-scope", resourceScopeId: scopeId } }));
    const counterpart = await withTenantDb(auth, tx => tx.assignment.create({ data: { ...context, subjectId: target, entitlementId: other.id, source: "DIRECT" } }));
    const policy = await withTenantDb(auth, async tx => {
      const p = await tx.soDPolicy.create({ data: { ...context, key: "review-test-conflict", scopeId, status: "ACTIVE" } });
      const [entitlementAId, entitlementBId] = [entitlementId, other.id].sort();
      await tx.soDRule.create({ data: { ...context, policyId: p.id, entitlementAId, entitlementBId } }); return p;
    });
    // Snapshot again after any previous assignment updates, without adding access.
    const fresh = await campaign(), freshItem = (await review.listReviewItems(auth, fresh.id)).find(row => row.assignmentId === item.assignmentId)!;
    const id = change();
    await expect(decide(fresh.id, freshItem.id, "KEEP", id)).rejects.toMatchObject({ code: "REQUIRES_REMEDIATION" });
    await withTenantDb(auth, async tx => {
      expect((await tx.accessReviewItem.findUniqueOrThrow({ where: { id: freshItem.id } })).reviewState).toBe("REQUIRES_REMEDIATION");
      expect((await tx.canonicalAdminAuditEvent.findFirstOrThrow({ where: { ...context, changeId: id } })).result).toBe("DENIED");
      await tx.soDPolicy.update({ where: { id: policy.id }, data: { status: "DISABLED" } });
      await tx.assignment.update({ where: { id: counterpart.id }, data: { status: "REVOKED" } });
    });
  });
  it("concurrent KEEP vs REVOKE: one decision only; no duplicate audit", async () => {
    const c = await campaign(), item = (await review.listReviewItems(auth, c.id))[0];
    const outcomes = await Promise.allSettled([decide(c.id, item.id, "KEEP"), decide(c.id, item.id, "REVOKE")]);
    expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.count({ where: { ...context, result: "SUCCESS", operation: { startsWith: "ACCESS_REVIEW.ITEM." }, metadata: { path: ["itemId"], equals: item.id } } }))).toBe(1);
  });
  it("audit failure rolls back REVOKE and decision together; legacy unchanged", async () => {
    const a = await grant(), c = await campaign(), item = (await review.listReviewItems(auth, c.id)).find(row => row.assignmentId === a.id)!;
    const suffix = randomUUID().replaceAll("-", ""), fn = `test_review_failure_${suffix}`;
    await owner.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW."organizationId"='${auth.organizationId}' AND NEW.operation='ACCESS_REVIEW.ITEM.REVOKE' THEN RAISE EXCEPTION 'TEST_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "CanonicalAdminAuditEvent" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(decide(c.id, item.id, "REVOKE")).rejects.toBeDefined();
      await withTenantDb(auth, async tx => {
        expect((await tx.assignment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ACTIVE");
        expect((await tx.accessReviewItem.findUniqueOrThrow({ where: { id: item.id } })).decision).toBe("PENDING");
      });
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "CanonicalAdminAuditEvent"`);
      await owner.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
    expect(await legacyDigest()).toEqual(legacyBefore);
    expect(await identities()).toEqual(subjectsBefore);
  });
});
