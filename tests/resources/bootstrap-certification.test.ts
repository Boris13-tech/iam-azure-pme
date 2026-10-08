import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { APPROVED_BYTES, APPROVED_DIGEST, MANIFEST as m } from "../../scripts/certification/resource-bootstrap-manifest";
import { assertCloneEndpoint, exactApproval, bootstrap, revokeBootstrap, auth } from "../../scripts/certification/resource-bootstrap";
import { withTenantDb } from "../../lib/db/scoped-client";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { SessionStore } from "../../lib/auth/session-store";
import { authorize } from "../../lib/resources/authorization";

describe("immutable operator approval", () => {
  it("matches the approved digest byte-for-byte; every altered field is refused", () => {
    expect(createHash("sha256").update(APPROVED_BYTES).digest("hex")).toBe(APPROVED_DIGEST);
    expect(exactApproval(APPROVED_BYTES)).toBe(true);
    const original = JSON.parse(APPROVED_BYTES);
    for (const field of Object.keys(original)) expect(exactApproval(JSON.stringify({ ...original, [field]: "altered" }))).toBe(false);
    expect(exactApproval(APPROVED_BYTES + "\n")).toBe(false);
  });
  it("production/other endpoint and owner role are impossible before database access", () => {
    const oldUrl = process.env.DATABASE_URL, oldBranch = process.env.LUXIA_BOOTSTRAP_BRANCH, oldEnv = process.env.LUXIA_BOOTSTRAP_ENVIRONMENT;
    try {
      process.env.LUXIA_BOOTSTRAP_BRANCH = m.branch; process.env.LUXIA_BOOTSTRAP_ENVIRONMENT = m.environment;
      for (const candidate of ["postgresql://app_user@production.invalid/neondb", "postgresql://neondb_owner@ep-delicate-bar-ahz7cosb-pooler.c-3.us-east-1.aws.neon.tech/neondb",
        "postgresql://app_user@ep-delicate-bar-ahz7cosb-pooler.c-3.us-east-1.aws.neon.tech/other"]) {
        process.env.DATABASE_URL = candidate; expect(assertCloneEndpoint).toThrow("EXACT_CERTIFICATION_CLONE_REQUIRED");
      }
    } finally {
      for (const [key, value] of Object.entries({ DATABASE_URL: oldUrl, LUXIA_BOOTSTRAP_BRANCH: oldBranch, LUXIA_BOOTSTRAP_ENVIRONMENT: oldEnv })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

async function preserved() {
  return withTenantDb(auth, tx => tx.$queryRaw`SELECT
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "Subject" t) AS subjects,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "IdentityAccount" t) AS accounts,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "Assignment" t WHERE id <> ${m.assignmentId}) AS existing_grants,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "User" t) AS users,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "Role" t) AS roles,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "Permission" t) AS permissions,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY "userId","roleId")::text,'')) FROM "UserRole" t) AS legacy_grants,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "AccessPolicy" t) AS legacy_policies,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM "AuditLog" t) AS legacy_audit,
    (SELECT count(*)::int FROM "LegacyUserBridge") AS bridges`);
}

describe.runIf(process.env.LUXIA_APPROVED_BOOTSTRAP_RLS === "true")("operator-approved exact clone ceremony", () => {
  it("real HTTP DENY → one approved bounded grant → ALLOW → revoke → DENY, replay and immutable evidence", async () => {
    assertCloneEndpoint();
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(m.validFrom));
    expect(Date.now()).toBeLessThan(Date.parse(m.validUntil));
    const baseline = await preserved();
    const account = await withTenantDb(auth, tx => tx.identityAccount.findFirstOrThrow({ where: { subjectId: auth.subjectId, status: "ACTIVE" } }));
    const session = await SessionStore.createSession({ ...auth, identityAccountId: account.id });
    const origin = "http://localhost:3195", route = `${origin}/api/resources/protected-resource-demo`;
    const server = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", "-p", "3195"],
      { env: { ...process.env, NEXT_PUBLIC_APP_URL: origin }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; server.stdout.on("data", chunk => { output += chunk; }); server.stderr.on("data", chunk => { output += chunk; });
    const headers = { cookie: `luxia_session=${session.rawToken}` };
    try {
      let ready = false;
      for (let index = 0; index < 120; index++) {
        try { if ((await fetch(route)).status === 401) { ready = true; break; } } catch {}
        await new Promise(done => setTimeout(done, 500));
      }
      expect(ready).toBe(true);
      expect((await fetch(route, { headers })).status).toBe(403);
      const outcomes = await Promise.all([bootstrap(), bootstrap()]);
      expect(outcomes.map(result => result.outcome).sort()).toEqual(["ALREADY_APPLIED", "CREATED"]);
      const allowed = await fetch(route, { headers }); expect(allowed.status).toBe(200);
      const allowBody = await allowed.json();
      const allowEvidence = await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findFirstOrThrow({ where: { id: allowBody.evidenceId } }));
      expect(allowEvidence).toMatchObject({ result: "SUCCESS", assignmentIds: [m.assignmentId] });
      const assignment = await withTenantDb(auth, tx => tx.assignment.findFirstOrThrow({ where: { id: m.assignmentId }, include: { entitlement: { include: { resourceScope: true } } } }));
      expect(assignment.source).toBe("DIRECT"); expect(assignment.entitlement.resourceScope?.kind).toBe("RESOURCE");
      expect(assignment.entitlement.resourceScope?.resourceId).toBe(m.resourceId);
      expect(assignment.validFrom?.getTime()).toBe(Date.parse(m.validFrom)); expect(assignment.validUntil?.getTime()).toBe(Date.parse(m.validUntil));
      expect(await bootstrap()).toMatchObject({ outcome: "ALREADY_APPLIED" });
      const broadened = JSON.stringify({ ...JSON.parse(APPROVED_BYTES), resourceId: randomUUID(), action: "*" });
      for (let index = 0; index < 2; index++) expect(await bootstrap(broadened)).toMatchObject({ outcome: "DENIED", reasonCode: "MANIFEST_OR_APPROVAL_MISMATCH" });
      const foreign = { ...auth, tenantId: randomUUID() };
      expect(await withTenantDb(foreign, tx => tx.assignment.count({ where: { id: m.assignmentId } }))).toBe(0);
      expect(await withTenantDb(foreign, tx => tx.canonicalAdminAuditEvent.count({ where: { changeId: `bootstrap:${m.operationId}` } }))).toBe(0);
      expect((await authorize({ ...foreign, resourceId: m.resourceId, entitlementKey: m.entitlementKey, action: m.action })).allowed).toBe(false);
      expect((await authorize({ ...auth, resourceId: m.resourceId, entitlementKey: m.entitlementKey, action: "other" })).allowed).toBe(false);
      expect((await authorize({ ...auth, resourceId: randomUUID(), entitlementKey: m.entitlementKey, action: m.action })).allowed).toBe(false);
      expect(await revokeBootstrap()).toMatchObject({ outcome: "REVOKED", replay: false });
      expect((await fetch(route, { headers })).status).toBe(403);
      expect(await bootstrap()).toMatchObject({ outcome: "DENIED", reasonCode: "BOOTSTRAP_ALREADY_REVOKED_OR_EXPIRED" });
      expect(await revokeBootstrap()).toMatchObject({ outcome: "REVOKED", replay: true });
      const rows = await withTenantDb(auth, tx => tx.assignment.findMany({ where: { entitlementId: m.entitlementId } }));
      expect(rows).toHaveLength(1); expect(rows[0].status).toBe("REVOKED");
      const audits = await withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.findMany({ where: { changeId: { startsWith: `bootstrap:${m.operationId}` } } }));
      expect(audits.filter(row => row.operation === "RESOURCE.ONBOARDING.BOOTSTRAP")).toHaveLength(1);
      expect(audits.filter(row => row.operation.endsWith(".REVOKE"))).toHaveLength(1);
      expect(audits.filter(row => row.result === "DENIED")).toHaveLength(2);
      const receipt = audits.find(row => row.operation === "RESOURCE.ONBOARDING.BOOTSTRAP")!;
      expect(receipt.metadata).toMatchObject({ manifestBinding: APPROVED_DIGEST, approval: { manifestBinding: APPROVED_DIGEST } });
      await expect(withTenantDb(auth, tx => tx.canonicalAdminAuditEvent.update({ where: { id: receipt.id }, data: { metadata: {} } }))).rejects.toBeDefined();
      expect(JSON.stringify(audits).match(/secret|password|bearer|access_token|refresh_token/i)).toBeNull();
      expect(output.includes(session.rawToken)).toBe(false);
      expect(await preserved()).toEqual(baseline);
      await SessionStore.revokeByToken(session.rawToken);
      expect((await fetch(route, { headers })).status).toBe(401);
    } finally {
      // Even a failed HTTP/assertion must revoke the exact operator grant.
      try {
        const remaining = await withTenantDb(auth, tx => tx.assignment.findFirst({ where: { id: m.assignmentId, status: "ACTIVE" } }));
        if (remaining) await revokeBootstrap();
      } finally {
        await SessionStore.revokeByToken(session.rawToken);
        if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else server.kill();
        await rawPrisma.$disconnect();
      }
    }
  }, 240_000);
});
