import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { SessionStore } from "../../lib/auth/session-store";
import { INTERNAL_RESOURCE as c } from "../../lib/resources/internal-capability";
import { planInternalOnboarding, configureInternalOnboarding, requestInternalGrant, exerciseInternalCapability, previewInternalOnboarding } from "../../lib/resources/onboarding";

const enabled = process.env.LUXIA_ONBOARDING_RLS === "true";
const auth = { organizationId: c.organizationId, tenantId: c.tenantId, subjectId: "30a15eda-24d3-40ef-8705-11c2e6e1b929" };
let operationId: string, baseline: unknown;
async function preserved() {
  return withTenantDb(auth, tx => tx.$queryRaw`SELECT
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "Subject" t) AS subjects,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "IdentityAccount" t) AS accounts,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "Assignment" t) AS assignments,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "User" t) AS users,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "Role" t) AS roles,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "Permission" t) AS permissions,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY "userId","roleId")::text,'')) FROM "UserRole" t) AS legacy_assignments,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "AccessPolicy" t) AS legacy_policies,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "AuditLog" t) AS legacy_audit,
    (SELECT count(*)::int FROM "LegacyUserBridge") AS bridges`);
}
describe.runIf(enabled)("isolated real Subject onboarding — bootstrap remains unapproved", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "http://missing");
    if (url.hostname !== "ep-delicate-bar-ahz7cosb-pooler.c-3.us-east-1.aws.neon.tech" || url.pathname !== "/neondb" || url.username !== "app_user")
      throw new Error("EXACT_ISOLATED_ONBOARDING_DB_REQUIRED");
    const subject = await withTenantDb(auth, tx => tx.subject.findFirst({ where: { id: auth.subjectId, lifecycleState: "ACTIVE" } }));
    if (!subject) throw new Error("REAL_CANONICAL_SUBJECT_REQUIRED_NO_FIXTURE_CREATION");
    baseline = await preserved();
  });
  afterAll(async () => { await rawPrisma.$disconnect(); });
  it("app_user minimal posture, forced RLS and no trigger EXECUTE", async () => {
    const rows = await withTenantDb(auth, tx => tx.$queryRaw<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean; owns: boolean; runtime_execute: boolean; public_execute: boolean }>>`
      SELECT current_user,rolsuper,rolbypassrls,
      EXISTS(SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND relnamespace='public'::regnamespace) AS owns,
      has_function_privilege(current_user,'luxia_resource_onboarding_evidence_guard()','EXECUTE') AS runtime_execute,
      EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.proname LIKE 'luxia_%' AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_roles WHERE rolname=current_user`);
    expect(rows[0]).toEqual({ current_user: "app_user", rolsuper: false, rolbypassrls: false, owns: false, runtime_execute: false, public_execute: false });
    const flags = await withTenantDb(auth, tx => tx.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('Resource','ResourceScope','Entitlement','Assignment','CanonicalAdminAuditEvent')`);
    expect(flags).toHaveLength(5); expect(flags.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
  it("before any grant the capability denies with committed canonical evidence", async () => {
    const result = await exerciseInternalCapability(auth);
    expect(result.allowed).toBe(false);
    const evidence = await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findFirst({ where: { id: result.evidenceId } }));
    expect(evidence).toMatchObject({ result: "DENIED", actorSubjectId: auth.subjectId, operation: "RESOURCE.CAPABILITY.READ" });
  });
  it("server-issued plan + concurrent configure/replay creates only one exact binding and one apply audit", async () => {
    const until = new Date(Date.now() + 1_800_000);
    const plan = await planInternalOnboarding(auth, auth.subjectId, until);
    operationId = plan.operationId;
    expect((await planInternalOnboarding(auth, auth.subjectId, until)).operationId).toBe(operationId);
    const results = await Promise.all([configureInternalOnboarding(auth, operationId), configureInternalOnboarding(auth, operationId)]);
    expect(results.map(row => row.replay).sort()).toEqual([false, true]);
    expect(results.every(row => row.assignmentsCreated === 0 && row.delegation === "BLOCKED")).toBe(true);
    await configureInternalOnboarding(auth, operationId);
    const counts = await withTenantDb(auth, async tx => ({
      resources: await tx.resource.count({ where: { id: c.resourceId } }), scopes: await tx.resourceScope.count({ where: { id: c.scopeId, kind: "RESOURCE" } }),
      entitlements: await tx.entitlement.count({ where: { id: c.entitlementId, resourceScopeId: c.scopeId } }),
      assignments: await tx.assignment.count({ where: { entitlementId: c.entitlementId } }),
      audit: await tx.canonicalAdminAuditEvent.count({ where: { changeId: `onboarding:${operationId}:CONFIGURE` } }),
    }));
    expect(counts).toEqual({ resources: 1, scopes: 1, entitlements: 1, assignments: 0, audit: 1 });
    expect(await previewInternalOnboarding(auth, operationId)).toMatchObject({ delegation: "BLOCKED", effectiveAuthority: false, sod: { decision: "ALLOW" } });
  });
  it("self-elevation + replay denies twice but has exactly one committed DENY", async () => {
    for (let index = 0; index < 2; index++) await expect(requestInternalGrant(auth, operationId)).rejects.toMatchObject({ code: "SELF_GRANT_FORBIDDEN" });
    const rows = await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findMany({ where: { changeId: `onboarding:${operationId}:GRANT` } }));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ result: "DENIED", metadata: { reasonCode: "SELF_GRANT_FORBIDDEN" } });
    expect((await exerciseInternalCapability(auth)).allowed).toBe(false);
  });
  it("receipt is immutable even with UPDATE/DELETE table privileges", async () => {
    await expect(withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.update({ where: { id: operationId }, data: { metadata: { wildcard: true } } }))).rejects.toBeDefined();
    await expect(withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.delete({ where: { id: operationId } }))).rejects.toBeDefined();
    expect((await previewInternalOnboarding(auth, operationId)).plan.targetSubjectId).toBe(auth.subjectId);
  });
  it("wrong tenant cannot read configuration or audit receipts through RLS", async () => {
    const foreign = { ...auth, tenantId: randomUUID() };
    const counts = await withTenantDb(foreign, async tx => ({ resource: await tx.resource.count({ where: { id: c.resourceId } }),
      scope: await tx.resourceScope.count({ where: { id: c.scopeId } }), audit: await tx.canonicalAdminAuditEvent.count({ where: { id: operationId } }) }));
    expect(counts).toEqual({ resource: 0, scope: 0, audit: 0 });
    await expect(configureInternalOnboarding(foreign, operationId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(withTenantDb(foreign, tx => tx.resource.create({ data: { organizationId: c.organizationId,
      tenantId: c.tenantId, id: randomUUID(), name: c.name, type: "API" } }))).rejects.toBeDefined();
  });
  it("real session HTTP denies, ignores client claims, forbids bootstrap and logout invalidates", async () => {
    const account = await withTenantDb(auth, tx => tx.identityAccount.findFirstOrThrow({ where: { subjectId: auth.subjectId, status: "ACTIVE" } }));
    const session = await SessionStore.createSession({ ...auth, identityAccountId: account.id });
    const origin = "http://localhost:3194";
    const server = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", "-p", "3194"],
      { env: { ...process.env, NEXT_PUBLIC_APP_URL: origin }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    // Keep diagnostics in memory; never print request headers, cookies or server logs.
    let output = ""; server.stdout.on("data", chunk => { output += chunk; }); server.stderr.on("data", chunk => { output += chunk; });
    const headers = { cookie: `luxia_session=${session.rawToken}`, origin, "content-type": "application/json" };
    try {
      let ready = false;
      for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`${origin}${c.route}`)).status === 401) { ready = true; break; } } catch {}
        await new Promise(done => setTimeout(done, 500));
      }
      expect(ready).toBe(true);
      const denied = await fetch(`${origin}${c.route}?subjectId=${randomUUID()}&resourceId=${randomUUID()}&action=admin&tenantId=${randomUUID()}`, { headers });
      expect(denied.status).toBe(403);
      const denial = await denied.json();
      expect(denial.error).toBe("RESOURCE_ACCESS_DENIED");
      const evidence = await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findFirst({ where: { id: denial.evidenceId } }));
      expect(evidence).toMatchObject({ actorSubjectId: auth.subjectId, result: "DENIED", metadata: { resourceId: c.resourceId, action: c.action } });
      expect((await fetch(`${origin}/api/canonical/resource-onboarding`, { method: "POST", headers,
        body: JSON.stringify({ command: "grant", operationId, approved: true }) })).status).toBe(400);
      const broadeningEvidence = await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findFirst({ where: {
        actorSubjectId: auth.subjectId, operation: "RESOURCE.ONBOARDING.REQUEST.DENIED", result: "DENIED",
        metadata: { path: ["reasonCode"], equals: "INVALID_REQUEST_BODY" },
      } }));
      expect(broadeningEvidence).not.toBeNull();
      expect((await fetch(`${origin}/api/canonical/resource-onboarding`, { method: "POST", headers,
        body: JSON.stringify({ command: "grant", operationId }) })).status).toBe(403);
      const response = await fetch(`${origin}/api/canonical/resource-onboarding`, { method: "POST", headers,
        body: JSON.stringify({ command: "configure", operationId }) });
      expect(response.status).toBe(200); expect((await response.json()).replay).toBe(true);
      await SessionStore.revokeByToken(session.rawToken);
      expect((await fetch(`${origin}${c.route}`, { headers })).status).toBe(401);
      expect(output.includes(session.rawToken)).toBe(false);
    } finally {
      await SessionStore.revokeByToken(session.rawToken);
      if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else server.kill();
    }
  }, 240_000);
  it("no secret-bearing metadata; canonical identities, existing assignments and legacy unchanged", async () => {
    const events = await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findMany({ where: {
      OR: [{ operation: { startsWith: "RESOURCE.ONBOARDING." } }, { operation: { startsWith: "RESOURCE.CAPABILITY." } }],
    }, select: { metadata: true } }));
    expect(JSON.stringify(events).match(/secret|token|password|credential|bearer/i)).toBeNull();
    expect(await preserved()).toEqual(baseline);
  });
});
