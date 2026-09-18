import { PrismaClient } from "@prisma/client";
import { SessionStore } from "../lib/auth/session-store";
import assert from "assert";

async function run() {
  console.log("Starting E2E HTTP verification (Staging Harness)...");

  const baseUrl = process.env.STAGING_BASE_URL ?? "http://localhost:3000";
  const runtimeDb = process.env.DATABASE_URL;
  const adminDb = process.env.DATABASE_MIGRATION_URL;

  assert(runtimeDb, "DATABASE_URL is required");
  assert(adminDb, "DATABASE_MIGRATION_URL is required");

  const adminPrisma = new PrismaClient({ datasourceUrl: adminDb });

  let org = await adminPrisma.organization.findFirst({ where: { name: "E2E Org" } });
  if (!org) org = await adminPrisma.organization.create({ data: { name: "E2E Org" } });
  
  let tenant = await adminPrisma.tenant.findFirst({ where: { name: "E2E Tenant", organizationId: org.id } });
  if (!tenant) tenant = await adminPrisma.tenant.create({ data: { name: "E2E Tenant", organizationId: org.id } });
  
  let provider = await adminPrisma.providerConnection.findFirst({
    where: {
      organizationId: org.id,
      providerType: "MICROSOFT_ENTRA",
      externalScopeId: "common"
    }
  });

  if (!provider) {
    provider = await adminPrisma.providerConnection.create({
      data: {
        organizationId: org.id,
        providerType: "MICROSOFT_ENTRA",
        externalScopeId: "common",
        name: "E2E Entra Provider"
      }
    });
  }

  const tenantId = tenant.id;
  const orgId = org.id;

  let user = await adminPrisma.user.findFirst({ where: { email: "e2e@example.com" }});
  if (!user) {
    user = await adminPrisma.user.create({ data: { email: "e2e@example.com", name: "E2E User" }});
    const subj = await adminPrisma.subject.create({
      data: {
        id: user.id,
        organizationId: orgId,
        tenantId,
        type: "HUMAN",
        name: "E2E User"
      }
    });
    await adminPrisma.identityAccount.create({ data: { organizationId: orgId, tenantId: tenantId, subjectId: subj.id, providerConnectionId: provider.id, externalObjectId: "oid_123" }});
  }
  
  const idAcc = await adminPrisma.identityAccount.findFirst({
    where: {
      organizationId: orgId,
      tenantId,
      subjectId: user.id
    }
  });
  assert(idAcc, "E2E IdentityAccount fixture must exist");

  const globalRole = await adminPrisma.role.findFirst({ where: { name: "Administrateur" } });
  assert(globalRole, "Global role 'Administrateur' must be pre-seeded in Staging environment");
  
  const existingUR = await adminPrisma.userRole.findFirst({ where: { userId: user.id, roleId: globalRole.id } });
  if (!existingUR) {
      await adminPrisma.userRole.create({ data: { userId: user.id, roleId: globalRole.id } });
  }

  const existingBridge = await adminPrisma.legacyUserBridge.findFirst({ where: { organizationId: orgId, legacyUserId: user.id } });
  if (!existingBridge) {
      await adminPrisma.legacyUserBridge.create({ data: { organizationId: orgId, legacyUserId: user.id, subjectId: user.id, status: "VALIDATED" } });
  }

  const authLoginRes = await fetch(baseUrl + "/auth/login?tenant=" + tenantId + "&connection=" + provider.id, { redirect: "manual" });
  assert(authLoginRes.status === 302 || authLoginRes.status === 307, "Should redirect, got " + authLoginRes.status);
  console.log("/auth/login                     PASS");
  
  const location = authLoginRes.headers.get("location");
  assert(location && location.includes("login.microsoftonline.com"), "Should redirect to Entra ID");
  const url = new URL(location);
  const state = url.searchParams.get("state");
  assert(state, "State should be in redirect URL");
  
  const tx = await adminPrisma.authTransaction.findUnique({
    where: { stateHash: state }
  });
  assert(tx && tx.nonce && tx.codeVerifier, "Nonce and PKCE should be created");
  console.log("state / nonce / PKCE            PASS");

  const { session, rawToken } = await SessionStore.createSession({ organizationId: orgId, tenantId: tenantId, subjectId: user.id, identityAccountId: idAcc.id }, "127.0.0.1", "e2e-agent");
  const cookie = "luxia_session=" + rawToken;
  
  const apiRolesRes = await fetch(baseUrl + "/api/roles", { headers: { Cookie: cookie, Accept: "application/json" } });
  assert(apiRolesRes.status === 200, "Should allow access with valid session cookie");
  console.log("valid session                   PASS");

  const missingDashRes = await fetch(baseUrl + "/dashboard", { headers: { Cookie: "" }, redirect: "manual" });
  assert(missingDashRes.status === 307 || missingDashRes.status === 302, "Should redirect to login");
  console.log("missing cookie redirect         PASS");

  const invalidTokenRes = await fetch(baseUrl + "/api/roles", { headers: { Cookie: "luxia_session=INVALID_RANDOM_TOKEN", Accept: "application/json" } });
  assert(invalidTokenRes.status === 401, "Should reject invalid random token");
  console.log("invalid random token → 401      PASS");

  const logoutRes = await fetch(baseUrl + "/auth/logout", { method: "POST", headers: { Cookie: cookie, Accept: "application/json" } });
  assert(logoutRes.status === 200 || logoutRes.status === 302 || logoutRes.status === 307, "Logout should succeed");
  const revokedSession = await adminPrisma.session.findUnique({ where: { id: session.id } });
  assert(revokedSession && revokedSession.revokedAt !== null, "Session should be marked as revoked");
  
  const revokedApiRes = await fetch(baseUrl + "/api/roles", { headers: { Cookie: cookie, Accept: "application/json" } });
  assert(revokedApiRes.status === 401, "Should reject revoked token");
  console.log("revoked token → 401             PASS");

  // Tests nécessitant une session valide pour muter
  const { session: session2, rawToken: rawToken2 } = await SessionStore.createSession({ organizationId: orgId, tenantId: tenantId, subjectId: user.id, identityAccountId: idAcc.id }, "127.0.0.1", "e2e-agent");
  const cookie2 = "luxia_session=" + rawToken2;

  const dummyUser = await adminPrisma.user.create({ data: { name: "Dummy " + Date.now(), email: "dummy" + Date.now() + "@x.com" }});
  await adminPrisma.subject.create({
    data: {
      id: dummyUser.id,
      organizationId: orgId,
      tenantId,
      type: "HUMAN",
      name: dummyUser.name
    }
  });
  await adminPrisma.legacyUserBridge.create({ data: { organizationId: orgId, legacyUserId: dummyUser.id, subjectId: dummyUser.id, status: "VALIDATED" }});

  const patchUserRes = await fetch(baseUrl + "/api/users/" + dummyUser.id, { method: "PATCH", headers: { Cookie: cookie2, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Updated Name" }) });
  assert(patchUserRes.status === 200, "PATCH should work");
  console.log("PATCH users/[id]                PASS");

  const deleteUserRes = await fetch(baseUrl + "/api/users/" + dummyUser.id, { method: "DELETE", headers: { Cookie: cookie2, Accept: "application/json" } });
  assert(deleteUserRes.status === 200, "DELETE should work");
  console.log("DELETE users/[id]               PASS");

  const patchRoleRes = await fetch(baseUrl + "/api/roles/" + globalRole.id, { method: "PATCH", headers: { Cookie: cookie2, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Hacked" }) });
  assert(patchRoleRes.status !== 200, "PATCH global role should be rejected");
  console.log("global Role mutation denied     PASS");

  const logoutRes2 = await fetch(baseUrl + "/auth/logout", { method: "POST", headers: { Cookie: cookie2, Accept: "application/json" } });
  const revokedSession2 = await adminPrisma.session.findUnique({ where: { id: session2.id } });
  assert(revokedSession2 && revokedSession2.revokedAt !== null, "Session should be marked as revoked");
  console.log("logout → revokedAt              PASS");

  const resolved = await SessionStore.getSession(rawToken2);
  assert(resolved === null, "SessionStore should not resolve revoked session");
  console.log("token reuse denied              PASS");

  console.log("ALL STAGING GATE 0 HTTP TESTS PASSED");
  process.exit(0);
}

run().catch(e => { console.error("E2E failed:", e); process.exit(1); });
