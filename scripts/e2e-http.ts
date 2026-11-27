import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { SessionStore } from "../lib/auth/session-store";
import assert from "assert";

async function ensureSubjectEntitlements(
  adminPrisma: PrismaClient,
  scope: { organizationId: string; tenantId: string },
  subjectId: string,
) {
  const keys = ["subjects.read", "subjects.create", "subjects.update"] as const;
  for (const key of keys) {
    const [resource, action] = key.split(".");
    const entitlement =
      (await adminPrisma.entitlement.findUnique({
        where: { organizationId_tenantId_key: { ...scope, key } },
      })) ??
      (await adminPrisma.entitlement.create({
        data: {
          ...scope,
          key,
          resource,
          action,
          description: `e2e-staging:${key}`,
        },
      }));

    const existing = await adminPrisma.assignment.findFirst({
      where: {
        ...scope,
        subjectId,
        entitlementId: entitlement.id,
        status: "ACTIVE",
      },
    });
    if (!existing) {
      await adminPrisma.assignment.create({
        data: {
          ...scope,
          subjectId,
          entitlementId: entitlement.id,
          source: "DIRECT",
          sourceRef: "native-role:LUXIA_ORG_ADMIN:v1",
          validFrom: new Date(),
        },
      });
    }
  }
}

async function run() {
  console.log("Starting E2E HTTP verification (Staging Harness)...");

  const baseUrl = process.env.STAGING_BASE_URL ?? "http://localhost:3000";
  const requestOrigin = process.env.STAGING_ORIGIN ?? new URL(baseUrl).origin;
  const runtimeDb = process.env.DATABASE_URL;
  const adminDb = process.env.DATABASE_MIGRATION_URL;

  assert(runtimeDb, "DATABASE_URL is required");
  assert(adminDb, "DATABASE_MIGRATION_URL is required");

  const adminPrisma = new PrismaClient({ datasourceUrl: adminDb });

  try {
    let org = await adminPrisma.organization.findFirst({ where: { name: "E2E Org" } });
    if (!org) org = await adminPrisma.organization.create({ data: { name: "E2E Org" } });

    let tenant = await adminPrisma.tenant.findFirst({
      where: { name: "E2E Tenant", organizationId: org.id },
    });
    if (!tenant) {
      tenant = await adminPrisma.tenant.create({
        data: { name: "E2E Tenant", organizationId: org.id },
      });
    }

    let provider = await adminPrisma.providerConnection.findFirst({
      where: {
        organizationId: org.id,
        providerType: "MICROSOFT_ENTRA",
        externalScopeId: "common",
      },
    });

    if (!provider) {
      provider = await adminPrisma.providerConnection.create({
        data: {
          organizationId: org.id,
          providerType: "MICROSOFT_ENTRA",
          externalScopeId: "common",
          name: "E2E Entra Provider",
        },
      });
    }

    const tenantId = tenant.id;
    const orgId = org.id;
    const scope = await adminPrisma.providerConnectionTenantScope.findFirst({
      where: { organizationId: orgId, tenantId, providerConnectionId: provider.id },
    });
    if (!scope) {
      await adminPrisma.providerConnectionTenantScope.create({
        data: { organizationId: orgId, tenantId, providerConnectionId: provider.id },
      });
    }

    let subject = await adminPrisma.subject.findFirst({
      where: { organizationId: orgId, tenantId, name: "E2E User" },
    });
    if (!subject) {
      subject = await adminPrisma.subject.create({
        data: {
          organizationId: orgId,
          tenantId,
          type: "HUMAN",
          name: "E2E User",
        },
      });
    }

    let idAcc = await adminPrisma.identityAccount.findFirst({
      where: {
        organizationId: orgId,
        tenantId,
        subjectId: subject.id,
      },
    });
    if (!idAcc) {
      idAcc = await adminPrisma.identityAccount.create({
        data: {
          organizationId: orgId,
          tenantId,
          subjectId: subject.id,
          providerConnectionId: provider.id,
          externalObjectId: `oid_${subject.id}`,
        },
      });
    }

    await ensureSubjectEntitlements(adminPrisma, { organizationId: orgId, tenantId }, subject.id);

    // Neighbor organization fixture to verify tenant isolation on canonical mutations.
    let otherOrg = await adminPrisma.organization.findFirst({ where: { name: "E2E Neighbor Org" } });
    if (!otherOrg) otherOrg = await adminPrisma.organization.create({ data: { name: "E2E Neighbor Org" } });
    let otherTenant = await adminPrisma.tenant.findFirst({
      where: { organizationId: otherOrg.id, name: "E2E Neighbor Tenant" },
    });
    if (!otherTenant) {
      otherTenant = await adminPrisma.tenant.create({
        data: { organizationId: otherOrg.id, name: "E2E Neighbor Tenant" },
      });
    }
    let otherSubject = await adminPrisma.subject.findFirst({
      where: { organizationId: otherOrg.id, tenantId: otherTenant.id, name: "Neighbor Subject" },
    });
    if (!otherSubject) {
      otherSubject = await adminPrisma.subject.create({
        data: {
          organizationId: otherOrg.id,
          tenantId: otherTenant.id,
          type: "HUMAN",
          name: "Neighbor Subject",
        },
      });
    }

    // Customer Self-Onboarding v1: Microsoft sign-in is resolved on the server from the organization identifier.
    const { slug } = await adminPrisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { slug: true },
    });
    const authLoginRes = await fetch(
      baseUrl + "/auth/login?org=" + encodeURIComponent(slug),
      { redirect: "manual" },
    );
    assert(
      authLoginRes.status === 302 || authLoginRes.status === 307,
      "Should redirect, got " + authLoginRes.status,
    );
    console.log("/auth/login                     PASS");

    const location = authLoginRes.headers.get("location");
    assert(location && location.includes("login.microsoftonline.com"), "Should redirect to Entra ID");
    const url = new URL(location);
    const state = url.searchParams.get("state");
    assert(state, "State should be in redirect URL");

    const tx = await adminPrisma.authTransaction.findUnique({
      where: { stateHash: state },
    });
    assert(tx && tx.nonce && tx.codeVerifier, "Nonce and PKCE should be created");
    console.log("state / nonce / PKCE            PASS");

    const { session, rawToken } = await SessionStore.createSession({
      organizationId: orgId,
      tenantId,
      subjectId: subject.id,
      identityAccountId: idAcc.id,
    });
    const cookie = "luxia_session=" + rawToken;

    const subjectsRes = await fetch(baseUrl + "/api/canonical/subjects", {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    assert(subjectsRes.status === 200, "Should allow canonical access with valid session cookie");
    console.log("valid session                   PASS");

    const missingDashRes = await fetch(baseUrl + "/dashboard", {
      headers: { Cookie: "" },
      redirect: "manual",
    });
    assert(
      missingDashRes.status === 307 || missingDashRes.status === 302,
      "Should redirect to login",
    );
    console.log("missing cookie redirect         PASS");

    const invalidTokenRes = await fetch(baseUrl + "/api/canonical/subjects", {
      headers: { Cookie: "luxia_session=INVALID_RANDOM_TOKEN", Accept: "application/json" },
    });
    assert(invalidTokenRes.status === 401, "Should reject invalid random token");
    console.log("invalid random token -> 401     PASS");

    const logoutRes = await fetch(baseUrl + "/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, Accept: "application/json", Origin: requestOrigin },
      redirect: "manual",
    });
    assert(
      logoutRes.status === 200 ||
        logoutRes.status === 302 ||
        logoutRes.status === 303 ||
        logoutRes.status === 307,
      "Logout should succeed",
    );
    const revokedSession = await adminPrisma.session.findUnique({ where: { id: session.id } });
    assert(revokedSession && revokedSession.revokedAt !== null, "Session should be marked as revoked");

    const revokedApiRes = await fetch(baseUrl + "/api/canonical/subjects", {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    assert(revokedApiRes.status === 401, "Should reject revoked token");
    console.log("revoked token -> 401            PASS");

    // Authenticated canonical mutations & cross-organization isolation checks
    const { session: session2, rawToken: rawToken2 } = await SessionStore.createSession({
      organizationId: orgId,
      tenantId,
      subjectId: subject.id,
      identityAccountId: idAcc.id,
    });
    const cookie2 = "luxia_session=" + rawToken2;

    const createSubjectRes = await fetch(baseUrl + "/api/canonical/subjects", {
      method: "POST",
      headers: {
        Cookie: cookie2,
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: requestOrigin,
        "x-luxia-change-id": `e2e-create-${randomUUID()}`,
      },
      body: JSON.stringify({ name: "Dummy " + Date.now(), type: "HUMAN" }),
    });
    assert(createSubjectRes.status === 201, "POST /api/canonical/subjects should succeed");
    const createdSubject = (await createSubjectRes.json()) as { id: string };
    console.log("POST canonical/subjects         PASS");

    const patchSubjectRes = await fetch(
      baseUrl + "/api/canonical/subjects/" + createdSubject.id,
      {
        method: "PATCH",
        headers: {
          Cookie: cookie2,
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: requestOrigin,
          "x-luxia-change-id": `e2e-patch-${randomUUID()}`,
        },
        body: JSON.stringify({ name: "Updated Name", lifecycleState: "RETIRED" }),
      },
    );
    assert(patchSubjectRes.status === 200, "PATCH /api/canonical/subjects/[id] should succeed");
    console.log("PATCH canonical/subjects/[id]   PASS");

    const crossOrgPatchRes = await fetch(
      baseUrl + "/api/canonical/subjects/" + otherSubject.id,
      {
        method: "PATCH",
        headers: {
          Cookie: cookie2,
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: requestOrigin,
          "x-luxia-change-id": `e2e-cross-org-${randomUUID()}`,
        },
        body: JSON.stringify({ name: "Cross Org Mutation" }),
      },
    );
    assert(crossOrgPatchRes.status === 404, "Cross-organization subject mutation must be rejected");
    console.log("cross-org isolation             PASS");

    for (const retiredPath of ["/api/roles", "/api/users"]) {
      const retiredRes = await fetch(baseUrl + retiredPath, {
        headers: { Cookie: cookie2, Accept: "application/json" },
      });
      assert(retiredRes.status === 410, `${retiredPath} must return 410 Gone`);
    }
    console.log("retired legacy routes -> 410    PASS");

    const logoutRes2 = await fetch(baseUrl + "/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie2, Accept: "application/json", Origin: requestOrigin },
      redirect: "manual",
    });
    assert(
      logoutRes2.status === 200 ||
        logoutRes2.status === 302 ||
        logoutRes2.status === 303 ||
        logoutRes2.status === 307,
      "Second logout should succeed",
    );
    const revokedSession2 = await adminPrisma.session.findUnique({ where: { id: session2.id } });
    assert(revokedSession2 && revokedSession2.revokedAt !== null, "Session should be marked as revoked");
    console.log("logout -> revokedAt             PASS");

    const resolved = await SessionStore.getSession(rawToken2);
    assert(resolved === null, "SessionStore should not resolve revoked session");
    console.log("token reuse denied              PASS");

    console.log("ALL STAGING GATE 0 HTTP TESTS PASSED");
  } finally {
    await adminPrisma.$disconnect();
  }
  process.exit(0);
}

run().catch((e) => {
  console.error("E2E failed:", e);
  process.exit(1);
});