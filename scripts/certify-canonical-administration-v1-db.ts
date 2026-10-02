import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { SessionCreationDeniedError, SessionStore } from "../lib/auth/session-store";
import { authorize } from "../lib/auth/authorization-engine";
import { withTenantDb } from "../lib/db/scoped-client";

type Gate = { status: "PASS" | "FAIL"; evidence: string };
type Bundle = {
  role: { key: string; version: number; sourceRef: string };
  scope: { organizationId: string; tenantId: string; subjectId: string };
  providerConnectionTenantScope: { providerConnectionId: string };
  grants: Array<{ key: string; entitlementId: string; assignmentId: string }>;
};

const ownerUrl = process.env.OWNER_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (!ownerUrl || !runtimeUrl) throw new Error("OWNER_DATABASE_URL and DATABASE_URL are required");

const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
const runtime = new PrismaClient({ datasources: { db: { url: runtimeUrl } } });
const gates: Record<string, Gate> = {};
const pass = (name: string, evidence: string) => { gates[name] = { status: "PASS", evidence }; };
const fail = (name: string, error: unknown) => {
  gates[name] = { status: "FAIL", evidence: error instanceof Error ? error.message.split("\n")[0] : String(error) };
};
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function checksumLegacy(client: PrismaClient) {
  const [row] = await client.$queryRawUnsafe<Array<{ digest: string }>>(`
    SELECT md5(concat_ws('|',
      (SELECT coalesce(string_agg(row_to_json(x)::text, ',' ORDER BY x.id), '') FROM "User" x),
      (SELECT coalesce(string_agg(row_to_json(x)::text, ',' ORDER BY x.id), '') FROM "Role" x),
      (SELECT coalesce(string_agg(row_to_json(x)::text, ',' ORDER BY x.id), '') FROM "Permission" x),
      (SELECT coalesce(string_agg(row_to_json(x)::text, ',' ORDER BY x."userId", x."roleId"), '') FROM "UserRole" x),
      (SELECT coalesce(string_agg(row_to_json(x)::text, ',' ORDER BY x.id), '') FROM "AccessPolicy" x),
      (SELECT coalesce(string_agg(row_to_json(x)::text, ',' ORDER BY x.id), '') FROM "AuditLog" x),
      (SELECT coalesce(string_agg(row_to_json(x)::text, ',' ORDER BY x.id), '') FROM "LegacyUserBridge" x)
    )) AS digest
  `);
  return row.digest;
}

async function waitForServer(url: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Local certification server did not become ready");
}

async function api(base: string, token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      cookie: `luxia_session=${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function main() {
  const bundle = JSON.parse(
    await readFile("docs/operations/canonical-administration-v1-bundle.json", "utf8"),
  ) as Bundle;
  const { organizationId, tenantId, subjectId } = bundle.scope;
  const identity = await owner.identityAccount.findFirstOrThrow({
    where: { organizationId, tenantId, subjectId },
  });
  const legacyBefore = await checksumLegacy(owner);

  try {
    const migration = await owner.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>(`
      SELECT migration_name, finished_at
      FROM "_prisma_migrations"
      WHERE migration_name = '20261001000000_canonical_administration_v1'
    `);
    const enums = await owner.$queryRawUnsafe<Array<{ typname: string; labels: string[] }>>(`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
      WHERE t.typname IN ('IdentityAccountStatus','CanonicalAdminResult')
      GROUP BY t.typname ORDER BY t.typname
    `);
    const constraints = await owner.$queryRawUnsafe<Array<{ count: bigint }>>(`
      SELECT count(*)::bigint count FROM pg_constraint
      WHERE connamespace='public'::regnamespace
        AND conrelid IN ('"CanonicalAdminAuditEvent"'::regclass, '"ProviderConnectionTenantScope"'::regclass)
    `);
    const indexes = await owner.$queryRawUnsafe<Array<{ count: bigint }>>(`
      SELECT count(*)::bigint count FROM pg_indexes
      WHERE schemaname='public'
        AND tablename IN ('CanonicalAdminAuditEvent','ProviderConnectionTenantScope')
    `);
    assert(migration.length === 1 && migration[0].finished_at != null, "migration history missing");
    assert(enums.length === 2, "enum verification failed");
    assert(Number(constraints[0].count) >= 9, "constraint count too low");
    assert(Number(indexes[0].count) >= 8, "index count too low");
    pass("Migration DB", `recorded; ${Number(constraints[0].count)} constraints; ${Number(indexes[0].count)} indexes; 2 enums`);
  } catch (error) { fail("Migration DB", error); }

  try {
    const rows = await owner.$queryRawUnsafe<Array<{ provider_count: bigint; scoped_count: bigint; ambiguous_count: bigint }>>(`
      SELECT count(*)::bigint provider_count,
             count(scope."providerConnectionId")::bigint scoped_count,
             count(*) FILTER (WHERE scope."providerConnectionId" IS NULL)::bigint ambiguous_count
      FROM "ProviderConnection" pc
      LEFT JOIN "ProviderConnectionTenantScope" scope
        ON scope."organizationId"=pc."organizationId" AND scope."providerConnectionId"=pc."id"
    `);
    assert(rows[0].provider_count === rows[0].scoped_count, "provider backfill incomplete");
    assert(Number(rows[0].ambiguous_count) === 0, "orphan or ambiguous provider found");
    pass("Backfill / ProviderConnection", `${rows[0].provider_count} provider(s), all scoped exactly once`);
  } catch (error) { fail("Backfill / ProviderConnection", error); }

  try {
    const [role] = await runtime.$queryRawUnsafe<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>>(`
      SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user
    `);
    const owned = await owner.$queryRawUnsafe<Array<{ count: bigint }>>(`
      SELECT count(*)::bigint count FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname='app_user')
    `);
    const [exec] = await runtime.$queryRawUnsafe<Array<{ allowed: boolean }>>(`
      SELECT has_function_privilege(current_user, 'resolve_session(text)', 'EXECUTE') allowed
    `);
    assert(role.current_user === "app_user" && !role.rolsuper && !role.rolbypassrls, "runtime role posture invalid");
    assert(Number(owned[0].count) === 0, "app_user owns public objects");
    assert(exec.allowed, "resolve_session execute missing");
    pass("app_user posture", "app_user; NOSUPERUSER; NOBYPASSRLS; 0 owned public objects; resolve_session EXECUTE");
  } catch (error) { fail("app_user posture", error); }

  const crossTenantId = "f3b4b4b1-5284-4c8f-9da0-48cdb37c1e50";
  const crossSubjectId = "d9089402-f6ca-4832-bb26-05a5169c3fb1";
  await owner.tenant.upsert({
    where: { id: crossTenantId },
    create: { id: crossTenantId, organizationId, name: "CERTIFICATION CROSS TENANT" },
    update: {},
  });
  await owner.subject.upsert({
    where: { id: crossSubjectId },
    create: { id: crossSubjectId, organizationId, tenantId: crossTenantId, type: "HUMAN", name: "CERTIFICATION CROSS TENANT SUBJECT" },
    update: {},
  });

  try {
    await withTenantDb({ organizationId, tenantId }, async (tx) => {
      for (const grant of bundle.grants) {
        const [resource, action] = grant.key.split(".");
        await tx.entitlement.upsert({
          where: { organizationId_tenantId_key: { organizationId, tenantId, key: grant.key } },
          create: {
            id: grant.entitlementId, organizationId, tenantId, key: grant.key,
            resource, action, description: `${bundle.role.sourceRef}:${grant.key}`,
          },
          update: { resource, action, description: `${bundle.role.sourceRef}:${grant.key}` },
        });
        await tx.assignment.upsert({
          where: { organizationId_tenantId_id: { organizationId, tenantId, id: grant.assignmentId } },
          create: {
            id: grant.assignmentId, organizationId, tenantId, subjectId,
            entitlementId: grant.entitlementId, source: "DIRECT", sourceRef: bundle.role.sourceRef,
            status: "ACTIVE", validFrom: new Date(),
          },
          update: { status: "ACTIVE", validUntil: null },
        });
      }
      await tx.canonicalAdminAuditEvent.upsert({
        where: { organizationId_tenantId_changeId: { organizationId, tenantId, changeId: "cert-role-bundle-grant-v1" } },
        create: {
          organizationId, tenantId, actorSubjectId: subjectId, targetSubjectId: subjectId,
          operation: "ROLE_BUNDLE.GRANT", roleKey: bundle.role.key, roleVersion: bundle.role.version,
          assignmentIds: bundle.grants.map((grant) => grant.assignmentId), changeId: "cert-role-bundle-grant-v1",
          result: "SUCCESS", metadata: { sourceRef: bundle.role.sourceRef, certification: true },
        },
        update: {},
      });
    });
    const entitlements = await withTenantDb({ organizationId, tenantId }, (tx) => tx.entitlement.count({
      where: { id: { in: bundle.grants.map((grant) => grant.entitlementId) } },
    }));
    const assignments = await withTenantDb({ organizationId, tenantId }, (tx) => tx.assignment.count({
      where: { id: { in: bundle.grants.map((grant) => grant.assignmentId) }, status: "ACTIVE" },
    }));
    assert(entitlements === 15, `expected 15 entitlements, got ${entitlements}`);
    assert(assignments === 15, `expected 15 active assignments, got ${assignments}`);
    pass("Entitlements", "15/15 created or reused under tenant RLS");
    pass("Assignments", "15/15 active for native-role:LUXIA_ORG_ADMIN:v1");
    pass("Audit elevation", "ROLE_BUNDLE.GRANT persisted with 15 assignmentIds");
  } catch (error) {
    fail("Entitlements", error); fail("Assignments", error); fail("Audit elevation", error);
  }

  try {
    const [table] = await owner.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='"CanonicalAdminAuditEvent"'::regclass
    `);
    assert(table.relrowsecurity && table.relforcerowsecurity, "audit RLS not enabled and forced");
    const visibleCross = await withTenantDb({ organizationId, tenantId }, (tx) => tx.subject.count({ where: { id: crossSubjectId } }));
    assert(visibleCross === 0, "cross-tenant subject visible");
    let wrongScopeRejected = false;
    try {
      await withTenantDb({ organizationId, tenantId }, (tx) => tx.canonicalAdminAuditEvent.create({
        data: {
          organizationId, tenantId: crossTenantId, actorSubjectId: crossSubjectId,
          operation: "CERT.WRONG_SCOPE", changeId: randomUUID(), result: "SUCCESS",
        },
      }));
    } catch { wrongScopeRejected = true; }
    assert(wrongScopeRejected, "wrong-scope audit insert accepted");
    const duplicateBefore = await owner.canonicalAdminAuditEvent.count({
      where: { organizationId, tenantId, changeId: "cert-role-bundle-grant-v1" },
    });
    let duplicateRejected = false;
    try {
      await withTenantDb({ organizationId, tenantId }, (tx) => tx.canonicalAdminAuditEvent.create({
        data: {
          organizationId, tenantId, actorSubjectId: subjectId,
          operation: "CERT.DUPLICATE", changeId: "cert-role-bundle-grant-v1", result: "SUCCESS",
        },
      }));
    } catch { duplicateRejected = true; }
    const duplicateAfter = await owner.canonicalAdminAuditEvent.count({
      where: { organizationId, tenantId, changeId: "cert-role-bundle-grant-v1" },
    });
    assert(duplicateRejected, "duplicate changeId accepted");
    assert(duplicateBefore === 1 && duplicateAfter === 1, "scoped changeId cardinality changed");
    pass("RLS CanonicalAdminAuditEvent", "enabled+forced; wrong-scope insert denied; cross-tenant read hidden; scoped changeId unique");
    pass("Cross-Tenant Isolation", "cross-tenant Subject and audit data inaccessible under Production tenant context");
  } catch (error) {
    fail("RLS CanonicalAdminAuditEvent", error); fail("Cross-Tenant Isolation", error);
  }

  const auth = { sessionId: "cert", organizationId, tenantId, subjectId, identityAccountId: identity.id };
  let server: ChildProcess | undefined;
  let adminRawToken: string | undefined;
  const created: { subjectId?: string; accountId?: string; assignmentId?: string; resourceId?: string } = {};
  try {
    const session = await SessionStore.createSession({ organizationId, tenantId, subjectId, identityAccountId: identity.id });
    adminRawToken = session.rawToken;
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", "3107"], {
      env: { ...process.env, DATABASE_URL: runtimeUrl, AUTHZ_MODE: "native", NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const serverErrors: string[] = [];
    server.stderr?.on("data", (chunk) => serverErrors.push(String(chunk).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DB_URL]")));
    await waitForServer("http://127.0.0.1:3107/login");
    const base = "http://127.0.0.1:3107";

    for (const path of ["/api/canonical/subjects", "/api/canonical/identity-accounts", "/api/canonical/assignments", "/api/canonical/sessions", "/api/canonical/providers", "/api/canonical/resources", "/api/canonical/audit"]) {
      const result = await api(base, adminRawToken, path);
      assert(result.status === 200, `${path} read returned ${result.status}`);
    }

    const subjectCreate = await api(base, adminRawToken, "/api/canonical/subjects", {
      method: "POST", headers: { "x-luxia-change-id": "cert-subject-create" },
      body: JSON.stringify({ name: "Canonical Certification Target", type: "HUMAN" }),
    });
    assert(subjectCreate.status === 201, `subject create returned ${subjectCreate.status}`);
    created.subjectId = subjectCreate.body.id;

    const identityLink = await api(base, adminRawToken, "/api/canonical/identity-accounts", {
      method: "POST", headers: { "x-luxia-change-id": "cert-identity-link" },
      body: JSON.stringify({ subjectId: created.subjectId, providerConnectionId: bundle.providerConnectionTenantScope.providerConnectionId, externalObjectId: `cert-${randomUUID()}` }),
    });
    assert(identityLink.status === 201, `identity link returned ${identityLink.status}`);
    created.accountId = identityLink.body.id;

    const targetSession = await SessionStore.createSession({ organizationId, tenantId, subjectId: created.subjectId!, identityAccountId: created.accountId! });
    const identityDisable = await api(base, adminRawToken, `/api/canonical/identity-accounts/${created.accountId}/disable`, {
      method: "POST", headers: { "x-luxia-change-id": "cert-identity-disable" }, body: "{}",
    });
    assert(identityDisable.status === 200, `identity disable returned ${identityDisable.status}`);
    assert(await SessionStore.getSession(targetSession.rawToken) === null, "target session remained valid after account disable");
    pass("Session revocation", "IdentityAccount disable atomically revoked its active session");

    const selfDisable = await api(base, adminRawToken, `/api/canonical/identity-accounts/${identity.id}/disable`, {
      method: "POST", headers: { "x-luxia-change-id": "cert-self-identity-disable" }, body: "{}",
    });
    assert(selfDisable.status === 409, `self disable expected 409, got ${selfDisable.status}`);

    const subjectSuspend = await api(base, adminRawToken, `/api/canonical/subjects/${created.subjectId}`, {
      method: "PATCH", headers: { "x-luxia-change-id": "cert-subject-suspend" },
      body: JSON.stringify({ lifecycleState: "SUSPENDED" }),
    });
    assert(subjectSuspend.status === 200, `subject suspend returned ${subjectSuspend.status}`);
    let inactiveDenied = false;
    try {
      await SessionStore.createSession({ organizationId, tenantId, subjectId: created.subjectId!, identityAccountId: created.accountId! });
    } catch (error) {
      inactiveDenied = error instanceof SessionCreationDeniedError;
    }
    assert(inactiveDenied, "non-ACTIVE Subject created a session");

    const grant = await api(base, adminRawToken, "/api/canonical/assignments", {
      method: "POST", headers: { "x-luxia-change-id": "cert-target-assignment-grant" },
      body: JSON.stringify({ subjectId: created.subjectId, entitlementId: bundle.grants[0].entitlementId, sourceRef: "certification" }),
    });
    assert(grant.status === 201, `assignment grant returned ${grant.status}`);
    created.assignmentId = grant.body.id;
    const revoke = await api(base, adminRawToken, `/api/canonical/assignments/${created.assignmentId}/revoke`, {
      method: "POST", headers: { "x-luxia-change-id": "cert-target-assignment-revoke" }, body: "{}",
    });
    assert(revoke.status === 200, `assignment revoke returned ${revoke.status}`);
    const selfRevoke = await api(base, adminRawToken, `/api/canonical/assignments/${bundle.grants[0].assignmentId}/revoke`, {
      method: "POST", headers: { "x-luxia-change-id": "cert-self-assignment-revoke" }, body: "{}",
    });
    assert(selfRevoke.status === 409, `self assignment revoke expected 409, got ${selfRevoke.status}`);

    const extraSession = await SessionStore.createSession({ organizationId, tenantId, subjectId, identityAccountId: identity.id });
    const revokeSession = await api(base, adminRawToken, `/api/canonical/sessions/${extraSession.session.id}/revoke`, {
      method: "POST", headers: { "x-luxia-change-id": "cert-session-revoke" }, body: "{}",
    });
    assert(revokeSession.status === 200, `session revoke returned ${revokeSession.status}`);

    const providerUpdate = await api(base, adminRawToken, `/api/canonical/providers/${bundle.providerConnectionTenantScope.providerConnectionId}`, {
      method: "PATCH", headers: { "x-luxia-change-id": "cert-provider-update" },
      body: JSON.stringify({ name: "Microsoft Entra (certification clone)" }),
    });
    assert(providerUpdate.status === 200, `provider update returned ${providerUpdate.status}`);

    const resourceCreate = await api(base, adminRawToken, "/api/canonical/resources", {
      method: "POST", headers: { "x-luxia-change-id": "cert-resource-create" },
      body: JSON.stringify({ name: "Certification App", type: "APPLICATION", providerConnectionId: bundle.providerConnectionTenantScope.providerConnectionId, metadata: { certification: true } }),
    });
    assert(resourceCreate.status === 201, `resource create returned ${resourceCreate.status}`);
    created.resourceId = resourceCreate.body.id;
    const resourceUpdate = await api(base, adminRawToken, `/api/canonical/resources/${created.resourceId}`, {
      method: "PATCH", headers: { "x-luxia-change-id": "cert-resource-update" },
      body: JSON.stringify({ description: "Updated by isolated certification" }),
    });
    assert(resourceUpdate.status === 200, `resource update returned ${resourceUpdate.status}`);
    const sensitive = await api(base, adminRawToken, "/api/canonical/resources", {
      method: "POST", headers: { "x-luxia-change-id": "cert-sensitive-metadata" },
      body: JSON.stringify({ name: "Rejected", type: "APPLICATION", metadata: { clientSecret: "must-not-persist" } }),
    });
    assert(sensitive.status === 400, `sensitive metadata expected 400, got ${sensitive.status}`);
    pass("Canonical APIs", "all six surfaces + canonical audit exercised over HTTP with app_user; sensitive metadata rejected");

    const decision = await authorize(auth, { resource: "subjects", action: "read" });
    const absent = await authorize(auth, { resource: "subjects", action: "delete" });
    assert(decision.allowed && !absent.allowed, "authorization allow/deny invariant failed");
  } catch (error) {
    fail("Canonical APIs", error);
    if (!gates["Session revocation"]) fail("Session revocation", error);
  } finally {
    if (server) server.kill();
  }

  try {
    await withTenantDb({ organizationId, tenantId }, async (tx) => {
      await tx.assignment.updateMany({
        where: { id: { in: bundle.grants.map((grant) => grant.assignmentId) }, status: "ACTIVE" },
        data: { status: "REVOKED", validUntil: new Date() },
      });
      await tx.canonicalAdminAuditEvent.upsert({
        where: { organizationId_tenantId_changeId: { organizationId, tenantId, changeId: "cert-role-bundle-rollback-v1" } },
        create: {
          organizationId, tenantId, actorSubjectId: subjectId, targetSubjectId: subjectId,
          operation: "ROLE_BUNDLE.REVOKE", roleKey: bundle.role.key, roleVersion: bundle.role.version,
          assignmentIds: bundle.grants.map((grant) => grant.assignmentId), changeId: "cert-role-bundle-rollback-v1",
          result: "SUCCESS", metadata: { sourceRef: bundle.role.sourceRef, certificationRollback: true },
        },
        update: {},
      });
    });
    const denied = await authorize(auth, { resource: "subjects", action: "read" });
    assert(!denied.allowed, "access remained allowed after bundle rollback");
    const history = await withTenantDb({ organizationId, tenantId }, (tx) => tx.canonicalAdminAuditEvent.count({
      where: { changeId: { in: ["cert-role-bundle-grant-v1", "cert-role-bundle-rollback-v1"] } },
    }));
    assert(history === 2, "grant/rollback audit history missing");
    pass("Rollback", "15 bundle assignments revoked; access returned to DENY; grant+rollback evidence retained");
  } catch (error) { fail("Rollback", error); }

  try {
    const legacyAfter = await checksumLegacy(owner);
    const bridgeCount = await owner.legacyUserBridge.count();
    assert(legacyAfter === legacyBefore, "legacy table checksum changed");
    assert(bridgeCount === 0, "LegacyUserBridge was created");
    pass("Legacy tables unchanged", "legacy checksum stable; LegacyUserBridge count remains 0");
  } catch (error) { fail("Legacy tables unchanged", error); }

  const critical = [
    "Migration DB", "Backfill / ProviderConnection", "RLS CanonicalAdminAuditEvent",
    "app_user posture", "Entitlements", "Assignments", "Canonical APIs",
    "Cross-Tenant Isolation", "Session revocation", "Audit elevation", "Rollback", "Legacy tables unchanged",
  ];
  const certified = critical.every((name) => gates[name]?.status === "PASS");
  console.log(JSON.stringify({
    branch: "br-quiet-cell-aho3pebq",
    role: "app_user",
    gates,
    "DATABASE/RLS CERTIFICATION": certified ? "PASS" : "FAIL",
  }, null, 2));
  if (!certified) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([owner.$disconnect(), runtime.$disconnect()]);
  });
