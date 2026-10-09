import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { grantAssignment, revokeAssignment, updateAssignment } from "../../lib/resources/service";
import * as sod from "../../lib/resources/sod-service";
import { evaluateSoD } from "../../lib/resources/sod";

const auth = { organizationId: randomUUID(), tenantId: randomUUID(), subjectId: randomUUID() };
const context = { organizationId: auth.organizationId, tenantId: auth.tenantId };
const scopeId = randomUUID(), resourceId = randomUUID(), otherResource = randomUUID();
const a = randomUUID(), b = randomUUID(), target = randomUUID();
const change = () => `sod-test:${randomUUID()}`;
const expiry = () => new Date(Date.now() + 3600000);
let owner: PrismaClient;
let policyId: string;
let ruleId: string;
let first: string;
describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("SoD app_user PostgreSQL/RLS", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!(["localhost", "127.0.0.1"].includes(url.hostname) || (url.hostname === "ep-weathered-grass-ah5vrehj-pooler.c-3.us-east-1.aws.neon.tech" && ["/luxia_reviews_cert","/luxia_resources_diag_awake01","/luxia_resources_diag_concurrency02","/luxia_resources_diag_global01","/luxia_resources_diag_ci02","/luxia_resources_diag_ci03","/luxia_resources_diag_ci04","/luxia_resources_diag_ci05"].includes(url.pathname)) || (["ep-dark-king-ah402c68-pooler.c-3.us-east-1.aws.neon.tech", "ep-holy-forest-ah3ser8s-pooler.c-3.us-east-1.aws.neon.tech", "ep-ancient-base-ahfygu4z-pooler.c-3.us-east-1.aws.neon.tech", "ep-delicate-boat-ahnvfj7w-pooler.c-3.us-east-1.aws.neon.tech"].includes(url.hostname) && ["/luxia_resources_cert", "/luxia_sod_cert", "/luxia_reviews_cert"].includes(url.pathname)))) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${auth.organizationId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${auth.tenantId}, true)`;
      await tx.organization.create({ data: { id: auth.organizationId, name: "SoD isolated fixture" } });
      await tx.tenant.create({ data: { id: auth.tenantId, organizationId: auth.organizationId, name: "SoD isolated fixture" } });
      for (const id of [auth.subjectId, target]) await tx.subject.create({ data: { ...context, id, name: "SoD fixture", type: "HUMAN" } });
      for (const id of [resourceId, otherResource]) await tx.resource.create({ data: { ...context, id, name: "Fixture", type: "API" } });
      await tx.resourceScope.create({ data: { ...context, id: scopeId, key: "payments", kind: "RESOURCE", resourceId } });
      for (const [id, action] of [[a, "create"], [b, "approve"]]) {
        await tx.entitlement.create({ data: { ...context, id, key: `resource-scope:${scopeId}:${action}`, action, resource: "resource-scope", resourceScopeId: scopeId } });
        await tx.assignment.create({ data: { ...context, subjectId: auth.subjectId, entitlementId: id, source: "DIRECT" } });
      }
      for (const key of ["sod.read", "sod.manage", "assignments.manage"]) {
        const entitlement = await tx.entitlement.create({ data: { ...context, key, action: key.split(".")[1], resource: key.split(".")[0] } });
        await tx.assignment.create({ data: { ...context, subjectId: auth.subjectId, entitlementId: entitlement.id, source: "DIRECT" } });
      }
    }, { timeout: 120000 });
    policyId = (await sod.createSoDPolicy(auth, { key: "payments", scopeId }, change())).id;
    ruleId = (await sod.createSoDRule(auth, policyId, { entitlementAId: a, entitlementBId: b }, change())).id;
    // Administrator holding both would conflict too: policies deliberately apply universally.
    await withTenantDb(auth, tx => tx.assignment.updateMany({ where: { ...context, subjectId: auth.subjectId, entitlementId: b }, data: { status: "REVOKED" } }));
    await sod.setSoDPolicyStatus(auth, policyId, "ACTIVE", change());
    // Use an independent bounded delegator for B; no exemption for administrators.
    const delegator = randomUUID();
    await withTenantDb(auth, async tx => {
      await tx.subject.create({ data: { ...context, id: delegator, name: "Bounded B delegator", type: "HUMAN" } });
      const manage = await tx.entitlement.findFirstOrThrow({ where: { ...context, key: "assignments.manage" } });
      await tx.assignment.createMany({ data: [b, manage.id].map(entitlementId => ({ ...context, subjectId: delegator, entitlementId, source: "DIRECT" as const })) });
    });
    bAuth = { ...auth, subjectId: delegator };
  }, 120000);
  let bAuth = auth;
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });
  it("RLS enabled/forced and runtime nonprivileged", async () => {
    const rows = await withTenantDb(auth, tx => tx.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('SoDPolicy','SoDRule')`);
    expect(rows).toHaveLength(2); expect(rows.every(r => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    const roles = await withTenantDb(auth, tx => tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    expect(roles[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  it("A only ALLOW; conflicting B denied before persistence with committed exact audit", async () => {
    first = (await grantAssignment(auth, { subjectId: target, entitlementId: a, validUntil: expiry() }, change())).id;
    const changeId = change();
    await expect(grantAssignment(bAuth, { subjectId: target, entitlementId: b, validUntil: expiry() }, changeId)).rejects.toMatchObject({ code: "SOD_CONFLICT" });
    await withTenantDb(auth, async tx => {
      expect(await tx.assignment.count({ where: { ...context, subjectId: target, entitlementId: b, status: "ACTIVE" } })).toBe(0);
      const audit = await tx.canonicalAdminAuditEvent.findMany({ where: { ...context, changeId } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ operation: "ASSIGNMENT.DENIED.SOD", result: "DENIED", metadata: { subjectId: target, entitlementId: b, resourceId, policyId, ruleId, scopeType: "RESOURCE" } });
      expect(Object.keys(audit[0].metadata as object).sort()).toEqual(["subjectId","entitlementId","resourceId","policyId","ruleId","scopeType"].sort());
    });
    await expect(grantAssignment(bAuth, { subjectId: target, entitlementId: b, validUntil: expiry() }, changeId)).rejects.toMatchObject({ code: "CHANGE_ALREADY_APPLIED" });
  });
  it("revoked A ignored; B only ALLOW; reactivation DENY", async () => {
    await revokeAssignment(auth, first, change());
    const second = await grantAssignment(bAuth, { subjectId: target, entitlementId: b, validUntil: expiry() }, change());
    await expect(updateAssignment(auth, first, { status: "ACTIVE", validUntil: expiry() }, change())).rejects.toMatchObject({ code: "SOD_CONFLICT" });
    await revokeAssignment(bAuth, second.id, change());
  });
  it("disabled policy ALLOW and no disabled-policy DENY", async () => {
    await sod.setSoDPolicyStatus(auth, policyId, "DISABLED", change());
    const x = await grantAssignment(auth, { subjectId: target, entitlementId: a, validUntil: expiry() }, change());
    const y = await grantAssignment(bAuth, { subjectId: target, entitlementId: b, validUntil: expiry() }, change());
    await expect(sod.setSoDPolicyStatus(auth, policyId, "ACTIVE", change())).rejects.toMatchObject({ code: "SOD_CONFLICT" });
    expect((await sod.readSoDPolicy(auth, policyId, change())).status).toBe("DISABLED");
    await revokeAssignment(auth, x.id, change()); await revokeAssignment(bAuth, y.id, change());
    await sod.setSoDPolicyStatus(auth, policyId, "ACTIVE", change());
  });
  it("simultaneous conflicting grants cannot both succeed", async () => {
    const outcomes = await Promise.allSettled([
      grantAssignment(auth, { subjectId: target, entitlementId: a, validUntil: expiry() }, change()),
      grantAssignment(bAuth, { subjectId: target, entitlementId: b, validUntil: expiry() }, change()),
    ]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("wrong-resource request and cross-tenant data fail closed", async () => {
    await expect(withTenantDb(auth, tx => evaluateSoD(tx, { ...context, subjectId: target, entitlementId: a, scope: scopeId, resourceId: otherResource, assignmentOperation: "CREATE" }))).rejects.toMatchObject({ code: "SOD_SCOPE_MISMATCH" });
    const foreign = { ...auth, tenantId: randomUUID() };
    expect(await withTenantDb(foreign, tx => tx.soDPolicy.count())).toBe(0);
    expect(await withTenantDb(foreign, tx => tx.soDRule.count())).toBe(0);
    expect(await withTenantDb(foreign, tx => tx.canonicalAdminAuditEvent.count({ where: { operation: "ASSIGNMENT.DENIED.SOD" } }))).toBe(0);
    await expect(grantAssignment(foreign, { subjectId: target, entitlementId: b, validUntil: expiry() }, change())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("policy outside entitlement resources does not participate", async () => {
    await sod.setSoDPolicyStatus(auth, policyId, "DISABLED", change());
    const otherScope = await withTenantDb(auth, tx => tx.resourceScope.create({ data: { ...context, key: "other", kind: "RESOURCE", resourceId: otherResource } }));
    const policy = await sod.createSoDPolicy(auth, { key: "other", scopeId: otherScope.id }, change());
    await sod.createSoDRule(auth, policy.id, { entitlementAId: a, entitlementBId: b }, change());
    await sod.setSoDPolicyStatus(auth, policy.id, "ACTIVE", change());
    const decision = await withTenantDb(auth, tx => evaluateSoD(tx, { ...context, subjectId: target, entitlementId: a, scope: scopeId, assignmentOperation: "CREATE" }));
    expect(decision.decision).toBe("ALLOW");
  });
  it("expired counterpart ignored; suspended and retired subjects denied", async () => {
    const person = await withTenantDb(auth, tx => tx.subject.create({ data: { ...context, name: "Lifecycle fixture", type: "HUMAN" } }));
    await withTenantDb(auth, tx => tx.assignment.create({ data: { ...context, subjectId: person.id, entitlementId: a, source: "DIRECT", validFrom: new Date(Date.now() - 7200000), validUntil: new Date(Date.now() - 3600000) } }));
    await sod.setSoDPolicyStatus(auth, policyId, "ACTIVE", change()).catch(async error => {
      // Remove the winning grant from the prior concurrency test before reactivation.
      if (error.code !== "SOD_CONFLICT") throw error;
      await withTenantDb(auth, tx => tx.assignment.updateMany({ where: { ...context, subjectId: target }, data: { status: "REVOKED" } }));
      await sod.setSoDPolicyStatus(auth, policyId, "ACTIVE", change());
    });
    expect((await grantAssignment(bAuth, { subjectId: person.id, entitlementId: b, validUntil: expiry() }, change())).status).toBe("ACTIVE");
    for (const lifecycleState of ["SUSPENDED", "RETIRED"] as const) {
      await withTenantDb(auth, tx => tx.subject.update({ where: { id: person.id }, data: { lifecycleState } }));
      await expect(grantAssignment(auth, { subjectId: person.id, entitlementId: a, validUntil: expiry() }, change())).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
  it("direct SQL activation cannot bypass SoD", async () => {
    const person = await withTenantDb(auth, tx => tx.subject.create({ data: { ...context, name: "SQL fixture", type: "HUMAN" } }));
    await grantAssignment(auth, { subjectId: person.id, entitlementId: a, validUntil: expiry() }, change());
    await expect(withTenantDb(auth, tx => tx.$executeRaw`INSERT INTO "Assignment" (id,"organizationId","tenantId","subjectId","entitlementId",source,status,"updatedAt") VALUES (${randomUUID()},${context.organizationId},${context.tenantId},${person.id},${b},'DIRECT','ACTIVE',CURRENT_TIMESTAMP)`)).rejects.toMatchObject({ meta: { code: "23514", message: expect.stringContaining("SOD_CONFLICT") } });
    expect(await withTenantDb(auth, tx => tx.assignment.count({ where: { ...context, subjectId: person.id, entitlementId: b } }))).toBe(0);
  });
  it("nested invoker helper EXECUTE is required, but trigger entry-point EXECUTE is not", async () => {
    const person = await withTenantDb(auth, tx => tx.subject.create({ data: { ...context, name: "Privilege fixture", type: "HUMAN" } }));
    await grantAssignment(auth, { subjectId: person.id, entitlementId: a, validUntil: expiry() }, change());
    // Certification files run sequentially. Use the actual runtime connection,
    // not SET ROLE (not available to the Neon migration role). Always restore
    // this isolated database's helper ACL before allowing another test to run.
    await owner.$executeRawUnsafe('REVOKE EXECUTE ON FUNCTION public.luxia_sod_scope_contains(TEXT,TEXT,TEXT,TEXT) FROM app_user');
    try {
      await expect(withTenantDb(auth, tx => tx.$executeRaw`INSERT INTO "Assignment" (id,"organizationId","tenantId","subjectId","entitlementId",source,status,"updatedAt") VALUES (${randomUUID()},${context.organizationId},${context.tenantId},${person.id},${b},'DIRECT','ACTIVE',CURRENT_TIMESTAMP)`)).rejects.toMatchObject({ meta: { code: "42501", message: expect.stringContaining("luxia_sod_scope_contains") } });
    } finally {
      await owner.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION public.luxia_sod_scope_contains(TEXT,TEXT,TEXT,TEXT) TO app_user');
    }
    expect(await withTenantDb(auth, tx => tx.assignment.count({ where: { ...context, subjectId: person.id, entitlementId: b } }))).toBe(0);
    const privileges = await withTenantDb(auth, tx => tx.$queryRaw<Array<{ helper: boolean; guard: boolean }>>`SELECT has_function_privilege(current_user,'public.luxia_sod_scope_contains(text,text,text,text)','EXECUTE') helper,has_function_privilege(current_user,'public.luxia_sod_assignment_guard()','EXECUTE') guard`);
    expect(privileges).toEqual([{ helper: true, guard: false }]);
  });
});
