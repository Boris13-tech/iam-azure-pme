// Access review items carry the names a reviewer needs (person, entitlement, resources) under the item's own
// authorization: a reviewer without subjects.read / resources.read sees the names of the items they can read,
// and nothing from another campaign or another organization. app_user PostgreSQL with forced RLS.
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { requireNative } from "../../lib/resources/service";
import * as review from "../../lib/resources/access-reviews";

const A = { organizationId: randomUUID(), tenantId: randomUUID() }, B = { organizationId: randomUUID(), tenantId: randomUUID() };
const creator = { ...A, subjectId: randomUUID() }, reviewer = { ...A, subjectId: randomUUID() };
const creatorB = { ...B, subjectId: randomUUID() }, reviewerB = { ...B, subjectId: randomUUID() };
const alice = randomUUID(), bob = randomUUID(), carol = randomUUID();
const payroll = randomUUID(), crm = randomUUID(), foreignResource = randomUUID();
const payrollScope = randomUUID(), crmScope = randomUUID(), foreignScope = randomUUID();
const change = () => `review-labels-test:${randomUUID()}`;
let owner: PrismaClient;
let campaignA: string, campaignOther: string, campaignB: string;

async function fixture(tx: Prisma.TransactionClient, context: typeof A, rights: Array<[string, string[]]>) {
  await tx.$queryRaw`SELECT set_config('app.organization_id', ${context.organizationId}, true)`;
  await tx.$queryRaw`SELECT set_config('app.tenant_id', ${context.tenantId}, true)`;
  for (const [key, subjectIds] of rights) {
    const entitlement = await tx.entitlement.create({ data: { ...context, key, action: key.split(".")[1], resource: key.split(".")[0] } });
    for (const subjectId of subjectIds) await tx.assignment.create({ data: { ...context, subjectId, entitlementId: entitlement.id, source: "DIRECT" } });
  }
}
async function grantOn(tx: Prisma.TransactionClient, context: typeof A, subjectId: string, resourceScopeId: string, key: string, description: string | null) {
  const entitlement = await tx.entitlement.create({ data: { ...context, key, description, action: "read", resource: "resource-scope", resourceScopeId } });
  await tx.assignment.create({ data: { ...context, subjectId, entitlementId: entitlement.id, source: "DIRECT", sourceRef: randomUUID() } });
}
const open = (auth: typeof creator, scopeId: string, reviewerSubjectId: string) => review.createAccessReview(auth, { name: "Labels fixture", scopeId, reviewerSubjectId,
  startsAt: new Date(Date.now() - 60000), dueAt: new Date(Date.now() + 3600000) }, change());

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("Access review item labels (app_user PostgreSQL/RLS)", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${A.organizationId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${A.tenantId}, true)`;
      await tx.organization.create({ data: { id: A.organizationId, name: "Review labels fixture A" } });
      await tx.tenant.create({ data: { id: A.tenantId, organizationId: A.organizationId, name: "Review labels fixture A" } });
      for (const [id, name] of [[creator.subjectId, "Creator A"], [reviewer.subjectId, "Reviewer A"], [alice, "Alice Martin"], [bob, "Bob Durand"]])
        await tx.subject.create({ data: { ...A, id, type: "HUMAN", name } });
      await tx.resource.create({ data: { ...A, id: payroll, type: "API", name: "Paie API" } });
      await tx.resource.create({ data: { ...A, id: crm, type: "API", name: "CRM interne" } });
      await tx.resourceScope.create({ data: { ...A, id: payrollScope, key: "labels-payroll", kind: "RESOURCE", resourceId: payroll } });
      await tx.resourceScope.create({ data: { ...A, id: crmScope, key: "labels-crm", kind: "RESOURCE", resourceId: crm } });
      await grantOn(tx, A, alice, payrollScope, "payroll.read", "Lecture des fiches de paie");
      await grantOn(tx, A, bob, crmScope, "crm.read", null);
      // The reviewer holds only access_reviews.read and access_reviews.decide: no subjects.read, no resources.read.
      await fixture(tx, A, [["access_reviews.read", [creator.subjectId, reviewer.subjectId]], ["access_reviews.create", [creator.subjectId]],
        ["access_reviews.manage", [creator.subjectId]], ["access_reviews.decide", [reviewer.subjectId]]]);
    }, { timeout: 120000 });
    await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${B.organizationId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${B.tenantId}, true)`;
      await tx.organization.create({ data: { id: B.organizationId, name: "Review labels fixture B" } });
      await tx.tenant.create({ data: { id: B.tenantId, organizationId: B.organizationId, name: "Review labels fixture B" } });
      for (const [id, name] of [[creatorB.subjectId, "Creator B"], [reviewerB.subjectId, "Reviewer B"], [carol, "Carol Foreign"]])
        await tx.subject.create({ data: { ...B, id, type: "HUMAN", name } });
      await tx.resource.create({ data: { ...B, id: foreignResource, type: "API", name: "Foreign ledger" } });
      await tx.resourceScope.create({ data: { ...B, id: foreignScope, key: "labels-foreign", kind: "RESOURCE", resourceId: foreignResource } });
      await grantOn(tx, B, carol, foreignScope, "ledger.read", "Foreign ledger reader");
      await fixture(tx, B, [["access_reviews.read", [creatorB.subjectId, reviewerB.subjectId]], ["access_reviews.create", [creatorB.subjectId]],
        ["access_reviews.decide", [reviewerB.subjectId]]]);
    }, { timeout: 120000 });
    campaignA = (await open(creator, payrollScope, reviewer.subjectId)).id;
    campaignOther = (await open(creator, crmScope, reviewer.subjectId)).id;
    campaignB = (await open(creatorB, foreignScope, reviewerB.subjectId)).id;
  }, 180000);
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });

  it("the reviewer really has no subjects.read and no resources.read", async () => {
    for (const key of ["subjects.read", "resources.read"])
      await expect(withTenantDb(reviewer, tx => requireNative(tx, reviewer, key))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a reviewer without subjects.read sees the names of the items of their campaign, and only those", async () => {
    for (const pending of [false, true]) {
      const items = await review.listReviewItems(reviewer, campaignA, undefined, pending);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ subjectId: alice, subjectName: "Alice Martin", entitlementLabel: "Lecture des fiches de paie",
        resourceIds: [payroll], resourceNames: ["Paie API"] });
      // Only the three labels are added: no nested subject, entitlement or resource row.
      expect(items[0]).not.toHaveProperty("subject"); expect(items[0]).not.toHaveProperty("entitlement");
      const body = JSON.stringify(items);
      for (const other of ["Bob Durand", "CRM interne", "crm.read", "Carol Foreign", "Foreign ledger", "Creator A", "Reviewer A"]) expect(body).not.toContain(other);
    }
    // An entitlement without a description is shown by its key.
    const other = await review.listReviewItems(reviewer, campaignOther);
    expect(other.map(item => [item.subjectName, item.entitlementLabel, item.resourceNames])).toEqual([["Bob Durand", "crm.read", ["CRM interne"]]]);
    expect(JSON.stringify(other)).not.toContain("Alice Martin");
  });

  it("nothing for another organization, in either direction", async () => {
    await expect(review.listReviewItems(reviewer, campaignB)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(review.listReviewItems(reviewerB, campaignA)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(review.listReviewItems(reviewerB, campaignOther)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const own = await review.listReviewItems(reviewerB, campaignB);
    expect(own.map(item => [item.subjectName, item.entitlementLabel, item.resourceNames])).toEqual([["Carol Foreign", "Foreign ledger reader", ["Foreign ledger"]]]);
    expect(JSON.stringify(own)).not.toMatch(/Alice Martin|Bob Durand|Paie API|CRM interne/);
  });

  it("no names without access_reviews.read, even for the person under review", async () => {
    await expect(review.listReviewItems({ ...A, subjectId: alice }, campaignA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(review.listReviewItems({ ...B, subjectId: carol }, campaignB)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("RLS hides organization B from organization A's database context", async () => {
    // Without the explicit where clauses, the database itself still returns nothing of organization B.
    expect(await withTenantDb(reviewer, tx => tx.subject.count({ where: { id: carol } }))).toBe(0);
    expect(await withTenantDb(reviewer, tx => tx.resource.count({ where: { id: foreignResource } }))).toBe(0);
    expect(await withTenantDb(reviewer, tx => tx.accessReviewItem.count({ where: { campaignId: campaignB } }))).toBe(0);
  });
});
