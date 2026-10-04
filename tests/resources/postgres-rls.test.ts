import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { authorize } from "../../lib/resources/authorization";
import * as service from "../../lib/resources/service";
import { withTenantDb } from "../../lib/db/scoped-client";
import { SessionStore } from "../../lib/auth/session-store";
import { rawPrisma } from "../../lib/db/raw-prisma";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const org = randomUUID(), tenant = randomUUID(), otherTenant = randomUUID(), foreignOrg = randomUUID(), foreignTenant = randomUUID();
const actor = randomUUID(), beneficiary = randomUUID(), suspended = randomUUID(), retired = randomUUID();
const resourceId = randomUUID(), otherResource = randomUUID(), foreignResource = randomUUID();
const directScope = randomUUID(), groupScope = randomUUID(), tenantScope = randomUUID(), foreignScope = randomUUID();
const directEntitlement = randomUUID(), groupEntitlement = randomUUID(), tenantEntitlement = randomUUID();
const key = `resource-scope:${directScope}:read`;
const auth = { organizationId: org, tenantId: tenant, subjectId: actor };
const memberAuth = { ...auth, subjectId: beneficiary };
const change = () => `test:${randomUUID()}`;
let owner: PrismaClient;
let legacyBefore: unknown;
let memberAssignment: string;
let accountId: string;

async function owned<T>(scope: { organizationId: string; tenantId: string }, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return owner.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('app.organization_id', ${scope.organizationId}, true)`;
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${scope.tenantId}, true)`;
    return work(tx);
  }, { timeout: 120_000 });
}
async function legacyDigest() {
  return owner.$queryRawUnsafe(`SELECT md5(concat_ws('|',
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'') FROM "User" t),
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'') FROM "Role" t),
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'') FROM "Permission" t),
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY "userId","roleId")::text,'') FROM "UserRole" t),
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'') FROM "AccessPolicy" t),
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'') FROM "AuditLog" t),
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'') FROM "LegacyUserBridge" t))) AS digest`);
}

describe.runIf(enabled)("real app_user PostgreSQL/RLS resource certification", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    const endpoint = new URL(process.env.DATABASE_URL);
    if (!(["localhost", "127.0.0.1"].includes(endpoint.hostname) ||
      (endpoint.hostname === "ep-dark-king-ah402c68-pooler.c-3.us-east-1.aws.neon.tech" && ["/luxia_resources_cert", "/luxia_sod_cert"].includes(endpoint.pathname)))) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    legacyBefore = await legacyDigest();
    await owned(auth, async tx => {
      await tx.organization.create({ data: { id: org, name: "Resource certification fixture" } });
      await tx.tenant.create({ data: { id: tenant, organizationId: org, name: "Isolated fixture" } });
      for (const [id, lifecycleState] of [[actor, "ACTIVE"], [beneficiary, "ACTIVE"], [suspended, "SUSPENDED"], [retired, "RETIRED"]] as const) {
        await tx.subject.create({ data: { id, organizationId: org, tenantId: tenant, name: "Certification fixture", type: "HUMAN", lifecycleState } });
      }
      await tx.resource.createMany({ data: [resourceId, otherResource].map(id => ({ id, organizationId: org, tenantId: tenant, name: "Certification resource", type: "APPLICATION" })) });
      await tx.resourceScope.createMany({ data: [
        { id: directScope, organizationId: org, tenantId: tenant, key: "direct", kind: "RESOURCE", resourceId },
        { id: groupScope, organizationId: org, tenantId: tenant, key: "group", kind: "RESOURCE_GROUP" },
        { id: tenantScope, organizationId: org, tenantId: tenant, key: "tenant", kind: "TENANT" },
      ] });
      await tx.resourceScopeMember.create({ data: { organizationId: org, tenantId: tenant, scopeId: groupScope, resourceId } });
      for (const [id, scopeId] of [[directEntitlement, directScope], [groupEntitlement, groupScope], [tenantEntitlement, tenantScope]]) {
        await tx.entitlement.create({ data: { id, organizationId: org, tenantId: tenant, resourceScopeId: scopeId, key: `resource-scope:${scopeId}:read`, action: "read", resource: "resource-scope" } });
        await tx.assignment.create({ data: { organizationId: org, tenantId: tenant, subjectId: actor, entitlementId: id, source: "DIRECT" } });
      }
      memberAssignment = (await tx.assignment.create({ data: { organizationId: org, tenantId: tenant, subjectId: beneficiary, entitlementId: directEntitlement, source: "DIRECT" } })).id;
      for (const permission of ["resources.read", "resources.manage", "assignments.read", "assignments.manage", "audit.read", "sod.read", "sod.manage"]) {
        const entitlement = await tx.entitlement.create({ data: { organizationId: org, tenantId: tenant, key: permission, action: permission.split(".")[1], resource: permission.split(".")[0] } });
        await tx.assignment.create({ data: { organizationId: org, tenantId: tenant, subjectId: actor, entitlementId: entitlement.id, source: "DIRECT" } });
      }
      const provider = await tx.providerConnection.create({ data: { organizationId: org, providerType: "CUSTOM", externalScopeId: randomUUID(), name: "Isolated session fixture" } });
      accountId = (await tx.identityAccount.create({ data: { organizationId: org, tenantId: tenant, subjectId: actor, providerConnectionId: provider.id, externalObjectId: randomUUID() } })).id;
    });
    await owned({ organizationId: org, tenantId: otherTenant }, async tx => {
      await tx.tenant.create({ data: { id: otherTenant, organizationId: org, name: "Other fixture tenant" } });
      await tx.resource.create({ data: { id: foreignResource, organizationId: org, tenantId: otherTenant, type: "API", name: "Foreign fixture" } });
      await tx.resourceScope.create({ data: { id: foreignScope, organizationId: org, tenantId: otherTenant, kind: "TENANT", key: "foreign" } });
    });
    await owned({ organizationId: foreignOrg, tenantId: foreignTenant }, async tx => {
      await tx.organization.create({ data: { id: foreignOrg, name: "Foreign organization fixture" } });
      await tx.tenant.create({ data: { id: foreignTenant, organizationId: foreignOrg, name: "Foreign tenant fixture" } });
    });
  }, 120_000);
  afterAll(async () => { if (owner) await owner.$disconnect(); await rawPrisma.$disconnect(); });
  const request = () => ({ ...memberAuth, resourceId, entitlementKey: key, action: "read" });
  it("runtime is app_user NOSUPERUSER NOBYPASSRLS with no ownership", async () => {
    const rows = await withTenantDb(auth, tx => tx.$queryRaw<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>>`
      SELECT current_user, rolsuper, rolbypassrls, EXISTS(SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND relnamespace='public'::regnamespace) AS owns
      FROM pg_roles WHERE rolname=current_user`);
    expect(rows[0]).toEqual({ current_user: "app_user", rolsuper: false, rolbypassrls: false, owns: false });
    const flags = await withTenantDb(auth, tx => tx.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('Resource','Entitlement','Assignment','ResourceScope','ResourceScopeMember','CanonicalAdminAuditEvent')`);
    expect(flags).toHaveLength(6);
    expect(flags.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
  it("valid chain ALLOW and exact evidence", async () => {
    expect(await authorize(request())).toMatchObject({ allowed: true, assignmentIds: [memberAssignment], entitlementIds: [directEntitlement], scopeIds: [directScope] });
  });
  it("missing grant, wrong resource/key/action/tenant/organization DENY", async () => {
    for (const override of [{ subjectId: randomUUID() }, { resourceId: otherResource }, { entitlementKey: "not-bound" }, { action: "write" }, { tenantId: otherTenant }, { organizationId: foreignOrg }]) {
      expect((await authorize({ ...request(), ...override })).allowed).toBe(false);
    }
  });
  it("suspended and retired Subject DENY even with matching grants", async () => {
    for (const subjectId of [suspended, retired]) {
      await owned(auth, tx => tx.assignment.create({ data: { ...{ organizationId: org, tenantId: tenant }, subjectId, entitlementId: directEntitlement, source: "DIRECT" } }));
      expect((await authorize({ ...request(), subjectId })).allowed).toBe(false);
    }
  });
  it("revoked and expired grants DENY", async () => {
    await owned(auth, tx => tx.assignment.update({ where: { id: memberAssignment }, data: { status: "REVOKED" } }));
    expect((await authorize(request())).allowed).toBe(false);
    await owned(auth, tx => tx.assignment.update({ where: { id: memberAssignment }, data: { status: "ACTIVE", validFrom: new Date(Date.now() - 120_000), validUntil: new Date(Date.now() - 60_000) } }));
    expect((await authorize(request())).allowed).toBe(false);
    await owned(auth, tx => tx.assignment.update({ where: { id: memberAssignment }, data: { validFrom: null, validUntil: null } }));
  });
  it("disabled entitlement/resource/scope and unbound entitlement DENY", async () => {
    for (const model of ["entitlement", "resource", "resourceScope"] as const) {
      const id = model === "entitlement" ? directEntitlement : model === "resource" ? resourceId : directScope;
      await owned(auth, async tx => { if (model === "entitlement") await tx.entitlement.update({ where: { id }, data: { active: false } }); else if (model === "resource") await tx.resource.update({ where: { id }, data: { active: false } }); else await tx.resourceScope.update({ where: { id }, data: { active: false } }); });
      expect((await authorize(request())).allowed).toBe(false);
      await owned(auth, async tx => { if (model === "entitlement") await tx.entitlement.update({ where: { id }, data: { active: true } }); else if (model === "resource") await tx.resource.update({ where: { id }, data: { active: true } }); else await tx.resourceScope.update({ where: { id }, data: { active: true } }); });
    }
    expect((await authorize({ ...request(), entitlementKey: "resources.read" })).allowed).toBe(false);
  });
  it("group and TENANT scopes are explicit and never cross tenant", async () => {
    expect((await authorize({ ...auth, resourceId, entitlementKey: `resource-scope:${groupScope}:read`, action: "read" })).allowed).toBe(true);
    expect((await authorize({ ...auth, resourceId: otherResource, entitlementKey: `resource-scope:${groupScope}:read`, action: "read" })).allowed).toBe(false);
    expect((await authorize({ ...auth, resourceId: otherResource, entitlementKey: `resource-scope:${tenantScope}:read`, action: "read" })).allowed).toBe(true);
    expect((await authorize({ ...auth, resourceId: foreignResource, entitlementKey: `resource-scope:${tenantScope}:read`, action: "read" })).allowed).toBe(false);
  });
  it("cross-tenant rows invisible and writes blocked by RLS and composite FKs", async () => {
    await withTenantDb(auth, async tx => {
      expect(await tx.resource.findMany({ where: { id: foreignResource } })).toEqual([]);
      expect(await tx.resourceScope.findMany({ where: { id: foreignScope } })).toEqual([]);
      expect((await tx.resource.updateMany({ where: { id: foreignResource }, data: { name: "Should not change" } })).count).toBe(0);
    });
    await expect(withTenantDb(auth, tx => tx.resource.create({ data: { organizationId: org, tenantId: otherTenant, name: "Denied", type: "API" } }))).rejects.toThrow();
    await expect(withTenantDb(auth, tx => tx.resourceScope.create({ data: { organizationId: org, tenantId: tenant, key: randomUUID(), kind: "RESOURCE", resourceId: foreignResource } }))).rejects.toThrow();
    await expect(withTenantDb(auth, tx => tx.entitlement.create({ data: { organizationId: org, tenantId: tenant, key: randomUUID(), action: "read", resource: "resource-scope", resourceScopeId: foreignScope } }))).rejects.toThrow();
    await expect(withTenantDb(auth, tx => tx.resourceScope.create({ data: { organizationId: org, tenantId: tenant, key: randomUUID(), kind: "RESOURCE" } }))).rejects.toThrow();
  });
  it("real create/update/bind/grant/revoke mutations are atomically audited", async () => {
    const changeId = change();
    const resource = await service.createResource(auth, { name: "API certification", type: "API" }, changeId);
    const audit = await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findFirst({ where: { changeId } }));
    expect(audit).toMatchObject({ result: "SUCCESS", metadata: { resourceId: resource.id, resourceType: "API" } });
    await expect(service.createResource(auth, { name: "Duplicate request", type: "API" }, changeId)).rejects.toMatchObject({ code: "CHANGE_ALREADY_APPLIED" });
    const scope = await service.createScope(auth, { key: randomUUID(), kind: "RESOURCE", resourceId: resource.id }, change());
    const entitlement = await service.createEntitlement(auth, { scopeId: scope.id, action: "read", label: "Read" }, change());
    await owned(auth, tx => tx.assignment.create({ data: { organizationId: org, tenantId: tenant, subjectId: actor, entitlementId: entitlement.id, source: "DIRECT" } })); // Explicit isolated bootstrap, not a product auto-grant.
    const grantChange = change();
    const assignment = await service.grantAssignment(auth, { subjectId: beneficiary, entitlementId: entitlement.id, validUntil: new Date(Date.now() + 60_000) }, grantChange);
    expect((await authorize({ ...memberAuth, resourceId: resource.id, entitlementKey: entitlement.key, action: "read" })).allowed).toBe(true);
    await service.revokeAssignment(auth, assignment.id, change());
    expect((await authorize({ ...memberAuth, resourceId: resource.id, entitlementKey: entitlement.key, action: "read" })).allowed).toBe(false);
    await service.updateResource(auth, resource.id, { active: false }, change());
    await service.revokeEntitlement(auth, entitlement.id, change());
    const grantAudit = await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findFirst({ where: { changeId: grantChange } }));
    expect(grantAudit?.assignmentIds).toEqual([assignment.id]);
  });
  it("DENIED audit persists, no unauthorized mutation, foreign audit invisible", async () => {
    const changeId = change();
    const before = await withTenantDb(auth, tx => tx.resource.count());
    await expect(service.createResource(memberAuth, { name: "Denied", type: "DEVICE" }, changeId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await withTenantDb(auth, async tx => {
      expect(await tx.resource.count()).toBe(before);
      const events = await tx.canonicalAdminAuditEvent.findMany({ where: { changeId } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ result: "DENIED", metadata: { reasonCode: "FORBIDDEN" } });
    });
    expect(await withTenantDb({ organizationId: org, tenantId: otherTenant }, tx => tx.canonicalAdminAuditEvent.findMany({ where: { changeId } }))).toEqual([]);
  });
  it("audit failure rolls back a resource mutation", async () => {
    const before = await withTenantDb(auth, tx => tx.resource.count());
    // A failing audit FK in the same transaction must roll back the earlier insert.
    await expect(withTenantDb(auth, async tx => {
      await tx.resource.create({ data: { organizationId: org, tenantId: tenant, name: "Rollback proof", type: "WORKLOAD" } });
      await tx.canonicalAdminAuditEvent.create({ data: { organizationId: org, tenantId: tenant, actorSubjectId: randomUUID(), operation: "RESOURCE.CREATE", changeId: change(), result: "SUCCESS" } });
    })).rejects.toThrow();
    expect(await withTenantDb(auth, tx => tx.resource.count())).toBe(before);
  });
  it("self-grant and grant beyond actor authority denied with committed evidence", async () => {
    await expect(service.grantAssignment(auth, { subjectId: actor, entitlementId: directEntitlement, validUntil: new Date(Date.now() + 60_000) }, change())).rejects.toMatchObject({ code: "SELF_GRANT_FORBIDDEN" });
    const newScope = await service.createScope(auth, { kind: "TENANT", key: randomUUID() }, change());
    const newEntitlement = await service.createEntitlement(auth, { scopeId: newScope.id, action: "write", label: "Write" }, change());
    await expect(service.grantAssignment(auth, { subjectId: beneficiary, entitlementId: newEntitlement.id, validUntil: new Date(Date.now() + 60_000) }, change())).rejects.toMatchObject({ code: "GRANT_AUTHORITY_REQUIRED" });
  });
  it("authorization DENY is recorded as DENIED, without secret metadata", async () => {
    const changeId = change();
    const decision = await service.checkAccess(memberAuth, { resourceId: otherResource, entitlementKey: key, action: "read" }, changeId);
    expect(decision.allowed).toBe(false);
    const audit = await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findFirst({ where: { changeId } }));
    expect(audit?.result).toBe("DENIED");
    expect(JSON.stringify(audit?.metadata)).not.toMatch(/token|secret|password|credential|bearer/i);
  });
  it("all six real resource types supported", async () => {
    for (const type of ["APPLICATION", "API", "SERVICE", "DEVICE", "WORKLOAD", "AI_AGENT"] as const) {
      expect((await service.createResource(auth, { name: `Certification ${type}`, type }, change())).type).toBe(type);
    }
  });
  it("real HTTP APIs use persisted sessions and app_user, never body-supplied scope", async () => {
    const { rawToken } = await SessionStore.createSession({ ...auth, identityAccountId: accountId });
    const runtimeEnv: NodeJS.ProcessEnv = { ...process.env, NEXT_PUBLIC_APP_URL: "http://localhost:3193", AUTHZ_MODE: "native" };
    delete runtimeEnv.DATABASE_MIGRATION_URL;
    delete runtimeEnv.LUXIA_RESOURCE_OWNER_URL;
    const server = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", "3193"], { env: runtimeEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    // Deliberately consume, never publish, raw server output.
    server.stdout?.on("data", () => {}); server.stderr?.on("data", () => {});
    const base = "http://127.0.0.1:3193/api/canonical/resource-governance";
    const api = async (path: string, method = "GET", body?: unknown, session = rawToken) => {
      const response = await fetch(`${base}/${path}`, { method, headers: {
        "content-type": "application/json", "x-luxia-change-id": change(), cookie: `luxia_session=${session}`,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { const response = await fetch(`${base}/resources`); if (response.status === 401) { ready = true; break; } } catch {}
        await new Promise(done => setTimeout(done, 500));
      }
      expect(ready).toBe(true);
      expect((await api("resources")).status).toBe(200);
      expect((await api(`resources/${resourceId}`)).status).toBe(200);
      expect((await api(`resources/${foreignResource}`)).status).toBe(404);
      expect((await api("resources", "POST", { name: "Cross-tenant body", type: "API", tenantId: otherTenant })).status).toBe(400);
      const created = await api("resources", "POST", { name: "Real HTTP certification resource", type: "SERVICE" });
      expect(created.status).toBe(201);
      expect(created.body.tenantId).toBe(tenant);
      const scoped = await api("scopes", "POST", { kind: "RESOURCE", key: randomUUID(), resourceId: created.body.id });
      expect(scoped.status).toBe(201);
      const entitlement = await api("entitlements", "POST", { scopeId: scoped.body.id, action: "read", label: "HTTP read" });
      expect(entitlement.status).toBe(201);
      expect((await api("authorize", "POST", { resourceId: created.body.id, entitlementKey: entitlement.body.key, action: "read" })).body.allowed).toBe(false);
      await owned(auth, tx => tx.assignment.create({ data: { organizationId: org, tenantId: tenant, subjectId: actor, entitlementId: entitlement.body.id, source: "DIRECT" } }));
      expect((await api("authorize", "POST", { resourceId: created.body.id, entitlementKey: entitlement.body.key, action: "read" })).body.allowed).toBe(true);
      const granted = await api("assignments", "POST", { subjectId: beneficiary, entitlementId: entitlement.body.id, validUntil: new Date(Date.now() + 60_000).toISOString() });
      expect(granted.status).toBe(201);
      expect((await api(`assignments/${granted.body.id}/revoke`, "POST")).status).toBe(200);
      expect((await api("audit")).status).toBe(200);
      const sodApi = async (path: string, method = "GET", body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:3193/api/canonical/sod/${path}`, { method,
          headers: { "content-type": "application/json", "x-luxia-change-id": change(), cookie: `luxia_session=${rawToken}` },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      };
      const policy = await sodApi("policies", "POST", { key: randomUUID(), scopeId: scoped.body.id });
      expect(policy.status).toBe(200); expect(policy.body.status).toBe("DISABLED");
      expect((await sodApi(`policies/${policy.body.id}`)).status).toBe(200);
      const secondEntitlement = await api("entitlements", "POST", { scopeId: scoped.body.id, action: "approve", label: "HTTP approve" });
      const rule = await sodApi(`policies/${policy.body.id}/rules`, "POST", { entitlementAId: entitlement.body.id, entitlementBId: secondEntitlement.body.id });
      expect(rule.status).toBe(200);
      expect((await sodApi(`policies/${policy.body.id}`, "PATCH", { status: "ACTIVE" })).status).toBe(200);
      expect((await sodApi("evaluate", "POST", { subjectId: beneficiary, entitlementId: entitlement.body.id, scope: scoped.body.id })).body.decision).toBe("ALLOW");
      expect((await sodApi("conflicts")).status).toBe(200);
      expect((await sodApi(`rules/${rule.body.id}`, "DELETE")).body.enabled).toBe(false);
      expect((await sodApi(`policies/${randomUUID()}`)).status).toBe(404);
      expect((await sodApi("policies", "POST", { key: "foreign", scopeId: foreignScope })).status).toBe(404);
      expect((await sodApi("policies", "POST", { key: "override", scopeId: scoped.body.id, tenantId: otherTenant })).status).toBe(400);
      expect((await api("resources", "GET", undefined, "invalid-session")).status).toBe(401);
      await SessionStore.revokeByToken(rawToken);
      expect((await api("resources")).status).toBe(401);
    } finally {
      if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else server.kill();
      await new Promise<void>(done => { if (server.exitCode !== null) done(); else { server.once("exit", () => done()); setTimeout(done, 5000); } });
    }
  }, 240_000);
  it("legacy rows and bridges unchanged", async () => { expect(await legacyDigest()).toEqual(legacyBefore); });
});
