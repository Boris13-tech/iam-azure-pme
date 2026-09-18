import assert from "assert";
import { PrismaClient } from "@prisma/client";
import { SessionStore } from "../lib/auth/session-store";

async function run() {
  const baseUrl = "http://localhost:3000";
  console.log("Starting E2E HTTP verification...");

  console.log("Testing /login?error=test");
  const loginRes = await fetch(baseUrl + "/login?error=E2E_ERROR_TEST");
  const loginHtml = await loginRes.text();
  assert(loginHtml.includes("E2E_ERROR_TEST"), "/login should render the async searchParams error");
  console.log("/login?error                  PASS");

  const prisma = new PrismaClient({ datasourceUrl: "postgresql://app_user:app_password@localhost:5432/luxia_db?schema=public" });
  const adminPrisma = new PrismaClient({ datasourceUrl: "postgresql://prisma:prisma_password@localhost:5432/luxia_db?schema=public" });
  
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

  console.log("Testing /auth/login...");
  const authLoginRes = await fetch(baseUrl + "/auth/login?tenant=" + tenantId + "&connection=" + provider.id, { redirect: "manual" });
  assert(authLoginRes.status === 302 || authLoginRes.status === 307, "Should redirect, got " + authLoginRes.status + " " + await authLoginRes.text());
  const location = authLoginRes.headers.get("location");
  assert(location && location.includes("login.microsoftonline.com"), "Should redirect to Entra ID");
  const url = new URL(location);
  const state = url.searchParams.get("state");
  assert(state, "State should be in redirect URL");
  
  const tx = await adminPrisma.authTransaction.findUnique({
    where: { stateHash: state }
  });
  assert(tx, "AuthTransaction should be created in DB");
  assert(tx.nonce && tx.codeVerifier, "Nonce and PKCE should be created");
  console.log("/auth/login                         PASS\nstate + nonce + PKCE                PASS");

  const { session, rawToken } = await SessionStore.createSession({ organizationId: orgId, tenantId: tenantId, subjectId: user.id, identityAccountId: idAcc.id }, "127.0.0.1", "e2e-agent");
  const cookie = "luxia_session=" + rawToken;
  
  

  let globalRole = await adminPrisma.role.findFirst({ where: { name: "Administrateur" } });
  if (!globalRole) {
    globalRole = await adminPrisma.role.create({ data: { name: "Administrateur", description: "E2E", isCustom: false } });
    const perm1 = await adminPrisma.permission.upsert({ where: { action_resource: { action: "read", resource: "roles" } }, create: { action: "read", resource: "roles" }, update: {} });
    const perm2 = await adminPrisma.permission.upsert({ where: { action_resource: { action: "read", resource: "users" } }, create: { action: "read", resource: "users" }, update: {} });
    const perm3 = await adminPrisma.permission.upsert({ where: { action_resource: { action: "update", resource: "users" } }, create: { action: "update", resource: "users" }, update: {} });
    const perm4 = await adminPrisma.permission.upsert({ where: { action_resource: { action: "delete", resource: "users" } }, create: { action: "delete", resource: "users" }, update: {} });
    
    await adminPrisma.rolePermission.createMany({
      data: [
        { roleId: globalRole.id, permissionId: perm1.id },
        { roleId: globalRole.id, permissionId: perm2.id },
        { roleId: globalRole.id, permissionId: perm3.id },
        { roleId: globalRole.id, permissionId: perm4.id },
      ],
      skipDuplicates: true
    });
  }
  await adminPrisma.userRole.create({ data: { userId: user.id, roleId: globalRole.id } }).catch(() => {});


  
  await adminPrisma.legacyUserBridge.create({ data: { organizationId: orgId, legacyUserId: user.id, subjectId: user.id, status: "VALIDATED" } }).catch(() => {});

  const apiRolesRes = await fetch(baseUrl + "/api/roles", { headers: { Cookie: cookie, Accept: "application/json" } });
  assert(apiRolesRes.status === 200, "Should allow access with valid session cookie, got " + apiRolesRes.status + " " + await apiRolesRes.text());
  console.log("valid session cookie               PASS");

  
  const missingDashRes = await fetch(baseUrl + "/dashboard", { headers: { Cookie: "" }, redirect: "manual" });
  assert(missingDashRes.status === 307 || missingDashRes.status === 302, "Should redirect to login");
  console.log("missing cookie redirect            PASS");

  const invalidTokenRes = await fetch(baseUrl + "/api/roles", { headers: { Cookie: "luxia_session=INVALID_RANDOM_TOKEN", Accept: "application/json" } });
  assert(invalidTokenRes.status === 401, "Should reject invalid random token");
  console.log("invalid token rejection            PASS");


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

  const patchUserRes = await fetch(baseUrl + "/api/users/" + dummyUser.id, { method: "PATCH", headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Updated Name" }) });
  assert(patchUserRes.status === 200, "PATCH /api/users/[id] should work, got " + patchUserRes.status);
  console.log("PATCH /api/users/[id]         PASS");

  const deleteUserRes = await fetch(baseUrl + "/api/users/" + dummyUser.id, { method: "DELETE", headers: { Cookie: cookie, Accept: "application/json" } });
  assert(deleteUserRes.status === 200, "DELETE /api/users/[id] should work, got " + deleteUserRes.status);
  console.log("DELETE /api/users/[id]        PASS");

  if (globalRole) {
      const patchRoleRes = await fetch(baseUrl + "/api/roles/" + globalRole.id, { method: "PATCH", headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Hacked" }) });
      assert(patchRoleRes.status !== 200, "PATCH global role should be rejected");
      console.log("global Role freeze           PASS");
  }

  const logoutRes = await fetch(baseUrl + "/auth/logout", { method: "POST", headers: { Cookie: cookie, Accept: "application/json" } });
  assert(logoutRes.status === 200 || logoutRes.status === 302 || logoutRes.status === 307, "Logout should succeed");
  
  const revokedSession = await adminPrisma.session.findUnique({ where: { id: session.id } });
  assert(revokedSession, "Session record should be preserved");
  assert(revokedSession.revokedAt !== null, "Session should be marked as revoked");
  const resolved = await SessionStore.getSession(rawToken);
  assert(resolved === null, "SessionStore should not resolve revoked session");
  
  
  console.log("logout → revokedAt set             PASS");
  const revokedApiRes = await fetch(baseUrl + "/api/roles", { headers: { Cookie: cookie, Accept: "application/json" } });
  assert(revokedApiRes.status === 401, "Should reject revoked token");
  console.log("revoked token rejection            PASS
token reuse after logout           PASS");


  console.log("🎉 ALL E2E HTTP TESTS PASSED");
  process.exit(0);
}

run().catch(e => { console.error("E2E failed:", e); process.exit(1); });
