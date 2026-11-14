import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import { rawPrisma } from "../../lib/db/raw-prisma";
import * as governance from "../../lib/resources/service";
import * as sod from "../../lib/resources/sod-service";

// A key already used in the tenant is a controlled 409 refusal, journaled as DENIED with its reason code only,
// never a unique violation that aborts the transaction (500, no evidence). Uniqueness stays per tenant.
const tenants = [{ organizationId: randomUUID(), tenantId: randomUUID(), subjectId: randomUUID() }];
tenants.push({ organizationId: tenants[0].organizationId, tenantId: randomUUID(), subjectId: randomUUID() });
const [auth, other] = tenants;
const context = { organizationId: auth.organizationId, tenantId: auth.tenantId };
const change = () => `dup-key-test:${randomUUID()}`;
let owner: PrismaClient;

async function denial(changeId: string) {
  return withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findMany({ where: { ...context, changeId } }));
}
async function expectDenied(attempt: (changeId: string) => Promise<unknown>, code: string, operation: string) {
  const changeId = change();
  await expect(attempt(changeId)).rejects.toMatchObject({ code, httpStatus: 409 });
  const rows = await denial(changeId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ operation, result: "DENIED", actorSubjectId: auth.subjectId, assignmentIds: [] });
  expect(rows[0].metadata).toEqual({ reasonCode: code });
  // The denied change id is consumed like every other controlled refusal.
  await expect(attempt(changeId)).rejects.toMatchObject({ code: "CHANGE_ALREADY_APPLIED" });
}

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("duplicate governance keys (app_user PostgreSQL/RLS)", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    for (const tenant of tenants) await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${tenant.organizationId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant.tenantId}, true)`;
      if (tenant === auth) await tx.organization.create({ data: { id: auth.organizationId, name: "Duplicate keys fixture" } });
      const scope = { organizationId: tenant.organizationId, tenantId: tenant.tenantId };
      await tx.tenant.create({ data: { id: tenant.tenantId, organizationId: tenant.organizationId, name: "Duplicate keys fixture" } });
      await tx.subject.create({ data: { ...scope, id: tenant.subjectId, name: "Governance administrator", type: "HUMAN" } });
      for (const key of ["resources.read", "resources.manage", "sod.read", "sod.manage"]) {
        const entitlement = await tx.entitlement.create({ data: { ...scope, key, resource: key.split(".")[0], action: key.split(".")[1] } });
        await tx.assignment.create({ data: { ...scope, subjectId: tenant.subjectId, entitlementId: entitlement.id, source: "DIRECT" } });
      }
    }, { timeout: 120000 });
  }, 120000);
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });

  it("scope key taken: 409 SCOPE_KEY_TAKEN, one row, DENIED journaled; same key free in another tenant", async () => {
    await governance.createScope(auth, { key: "payments", kind: "TENANT" }, change());
    await expectDenied(changeId => governance.createScope(auth, { key: "payments", kind: "TENANT" }, changeId), "SCOPE_KEY_TAKEN", "RESOURCE.SCOPE.CREATE.DENIED");
    expect(await withTenantDb(auth, tx => tx.resourceScope.count({ where: { ...context, key: "payments" } }))).toBe(1);
    expect((await governance.createScope(other, { key: "payments", kind: "TENANT" }, change())).key).toBe("payments");
  });

  it("concurrent creations of one key: one SUCCESS, one journaled 409, never a 500", async () => {
    const ids = [change(), change()];
    const results = await Promise.allSettled(ids.map(id => governance.createScope(auth, { key: "concurrent", kind: "TENANT" }, id)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "SCOPE_KEY_TAKEN", httpStatus: 409 });
    const rows = await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findMany({ where: { ...context, changeId: { in: ids } } }));
    expect(rows.map(row => row.result).sort()).toEqual(["DENIED", "SUCCESS"]);
  });

  it("entitlement for the same scope and action: 409 ENTITLEMENT_KEY_TAKEN, also once retired", async () => {
    const scope = await governance.createScope(auth, { key: "ledger", kind: "TENANT" }, change());
    const entitlement = await governance.createEntitlement(auth, { scopeId: scope.id, action: "approve", label: "Approve" }, change());
    await expectDenied(changeId => governance.createEntitlement(auth, { scopeId: scope.id, action: "approve", label: "Again" }, changeId),
      "ENTITLEMENT_KEY_TAKEN", "RESOURCE.ENTITLEMENT.CREATE.DENIED");
    await governance.revokeEntitlement(auth, entitlement.id, change());
    await expectDenied(changeId => governance.createEntitlement(auth, { scopeId: scope.id, action: "approve", label: "After retirement" }, changeId),
      "ENTITLEMENT_KEY_TAKEN", "RESOURCE.ENTITLEMENT.CREATE.DENIED");
    expect(await withTenantDb(auth, tx => tx.entitlement.count({ where: { ...context, resourceScopeId: scope.id } }))).toBe(1);
  });

  it("SoD policy key taken: 409 SOD_POLICY_KEY_TAKEN, one policy", async () => {
    const scope = await governance.createScope(auth, { key: "sod-scope", kind: "TENANT" }, change());
    await sod.createSoDPolicy(auth, { key: "four-eyes", scopeId: scope.id }, change());
    await expectDenied(changeId => sod.createSoDPolicy(auth, { key: "four-eyes", scopeId: scope.id }, changeId), "SOD_POLICY_KEY_TAKEN", "SOD.POLICY.CREATE.DENIED");
    expect(await withTenantDb(auth, tx => tx.soDPolicy.count({ where: { ...context, key: "four-eyes" } }))).toBe(1);
  });

  it("resources have no business key: two resources may share a name", async () => {
    const first = await governance.createResource(auth, { name: "Payroll", type: "APPLICATION" }, change());
    const second = await governance.createResource(auth, { name: "Payroll", type: "APPLICATION" }, change());
    expect(first.id).not.toBe(second.id);
  });
});
