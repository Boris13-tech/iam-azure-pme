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
  console.log("✅ /login?error=... works");

  const adminPrisma = new PrismaClient({ datasourceUrl: "postgresql://prisma:prisma_password@localhost:5432/luxia_db?schema=public" });
  
  // Seed basic data if missing
  let org = await adminPrisma.organization.findFirst();
  if (!org) org = await adminPrisma.organization.create({ data: { name: "E2E Org" } });
  
  let tenant = await adminPrisma.tenant.findFirst({ where: { organizationId: org.id } });
  if (!tenant) tenant = await adminPrisma.tenant.create({ data: { name: "E2E Tenant", organizationId: org.id } });
  
  let provider = await adminPrisma.providerConnection.findFirst();
  if (!provider) provider = await adminPrisma.providerConnection.create({
     data: { organizationId: org.id, providerType: "MICROSOFT_ENTRA", configuration: { clientId: "dummy", tenantId: "dummy" }, externalScopeId: "dummy" }
  });

  const tenantId = tenant.id;
  const orgId = org.id;

  let user = await adminPrisma.user.findFirst({ where: { email: "e2e@example.com" }});
  if (!user) {
    user = await adminPrisma.user.create({ data: { email: "e2e@example.com", name: "E2E User" }});
    const subj = await adminPrisma.subject.create({ data: { id: user.id, organizationId: orgId, tenantId: tenantId, type: "HUMAN" }});
    await adminPrisma.identityAccount.create({ data: { organizationId: orgId, tenantId: tenantId, subjectId: subj.id, providerConnectionId: provider.id, externalObjectId: "oid_123" }});
  }
  let idAcc = await adminPrisma.identityAccount.findFirst({ where: { subjectId: user.id } });

  console.log("Testing /auth/login...");
  const authLoginRes = await fetch(baseUrl + "/auth/login?tenant=" + tenantId + "&connection=" + provider.id, { redirect: "manual" });
  assert(authLoginRes.status === 302 || authLoginRes.status === 307, "Should redirect, got " + authLoginRes.status + " " + await authLoginRes.text());
  const location = authLoginRes.headers.get("location");
  assert(location && location.includes("login.microsoftonline.com"), "Should redirect to Entra ID");
  const url = new URL(location);
  const state = url.searchParams.get("state");
  assert(state, "State should be in redirect URL");
  
  const tx = await adminPrisma.authTransaction.findUnique({ where: { state } });
  assert(tx, "AuthTransaction should be created in DB");
  assert(tx.nonce && tx.codeVerifier, "Nonce and PKCE should be created");
  console.log("✅ /auth/login flow generates correct state & PKCE");

  const { session, rawToken } = await SessionStore.createSession({ organizationId: orgId, tenantId: tenantId, subjectId: user.id, identityAccountId: idAcc.id }, "127.0.0.1", "e2e-agent");
  const cookie = "luxia_session=" + rawToken;
  
  const globalRole = await adminPrisma.role.findFirst({ where: { name: "Global Administrator" } });
  if (globalRole) await adminPrisma.userRole.create({ data: { userId: user.id, roleId: globalRole.id } }).catch(() => {});
  
  await adminPrisma.legacyUserBridge.create({ data: { organizationId: orgId, legacyUserId: user.id, subjectId: user.id, status: "VALIDATED" } }).catch(() => {});

  const apiRolesRes = await fetch(baseUrl + "/api/roles", { headers: { Cookie: cookie, Accept: "application/json" } });
  assert(apiRolesRes.status === 200, "Should allow access with valid session cookie, got " + apiRolesRes.status);
  console.log("✅ authenticated API allows access");

  const dashRes = await fetch(baseUrl + "/dashboard", { headers: { Cookie: "luxia_session=INVALID_TOKEN" }, redirect: "manual" });
  assert(dashRes.status === 307 || dashRes.status === 302, "Should redirect to login");
  console.log("✅ invalid session denies access");

  const dummyUser = await adminPrisma.user.create({ data: { name: "Dummy " + Date.now(), email: "dummy" + Date.now() + "@x.com" }});
  await adminPrisma.subject.create({ data: { id: dummyUser.id, organizationId: orgId, tenantId: tenantId, type: "HUMAN" }});
  await adminPrisma.legacyUserBridge.create({ data: { organizationId: orgId, legacyUserId: dummyUser.id, subjectId: dummyUser.id, status: "VALIDATED" }});

  const patchUserRes = await fetch(baseUrl + "/api/users/" + dummyUser.id, { method: "PATCH", headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Updated Name" }) });
  assert(patchUserRes.status === 200, "PATCH /api/users/[id] should work, got " + patchUserRes.status);
  console.log("✅ PATCH /api/users/[id] async params work");

  const deleteUserRes = await fetch(baseUrl + "/api/users/" + dummyUser.id, { method: "DELETE", headers: { Cookie: cookie, Accept: "application/json" } });
  assert(deleteUserRes.status === 200, "DELETE /api/users/[id] should work, got " + deleteUserRes.status);
  console.log("✅ DELETE /api/users/[id] async params work");

  if (globalRole) {
      const patchRoleRes = await fetch(baseUrl + "/api/roles/" + globalRole.id, { method: "PATCH", headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ name: "Hacked" }) });
      assert(patchRoleRes.status !== 200, "PATCH global role should be rejected");
      console.log("✅ PATCH /api/roles/[id] global freeze applied");
  }

  const logoutRes = await fetch(baseUrl + "/auth/logout", { method: "POST", headers: { Cookie: cookie, Accept: "application/json" } });
  assert(logoutRes.status === 200 || logoutRes.status === 302 || logoutRes.status === 307, "Logout should succeed");
  const revokedSession = await adminPrisma.session.findUnique({ where: { id: session.id } });
  assert(revokedSession, "Session record should be preserved");
  assert(revokedSession.revokedAt !== null, "Session should be marked as revoked");
  const resolved = await SessionStore.getSession(rawToken);
  assert(resolved === null, "SessionStore should not resolve revoked session");
  console.log("✅ /auth/logout successfully deletes session");

  console.log("🎉 ALL E2E HTTP TESTS PASSED");
  process.exit(0);
}

run().catch(e => { console.error("E2E failed:", e); process.exit(1); });
