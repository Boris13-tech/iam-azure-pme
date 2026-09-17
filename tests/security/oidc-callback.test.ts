import { adminPrisma } from "../helpers/admin-prisma";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { GET } from "../../app/auth/callback/route";
import { NextRequest } from "next/server";
import { rawPrisma } from "../../lib/db/raw-prisma";
import crypto from "crypto";
import { AuthTransactionStore } from "../../lib/auth/auth-transaction-store";

vi.mock("../../lib/auth/providers/entra", () => ({
  getEntraOIDCConfig: vi.fn().mockResolvedValue({
    config: {}, // we don't care about config since we mock openid-client
    redirectUri: "http://localhost:3000/auth/callback"
  })
}));

vi.mock("openid-client", () => ({
  authorizationCodeGrant: vi.fn().mockResolvedValue({
    claims: () => ({
      iss: "https://login.microsoftonline.com/tid-abc/v2.0",
      tid: "tid-abc",
      oid: "oid-abc",
      email: "test@example.com"
    })
  })
}));


const { mockCookieSet } = vi.hoisted(() => ({ mockCookieSet: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({
    get: vi.fn(),
    set: mockCookieSet,
  })),
  headers: vi.fn(() => ({
    get: vi.fn(() => null),
  })),
}));

describe("OIDC Callback Security", () => {
  let orgId: string;
  let tenantId: string;
  let subjectId: string;
  let identityAccountId: string;
  let providerConnectionId: string;

  beforeAll(async () => {
    const org = await adminPrisma.organization.create({ data: { name: "Test Org 4" } });
    orgId = org.id;
    const tenant = await adminPrisma.tenant.create({ data: { organizationId: orgId, name: "Test Tenant 4" } });
    tenantId = tenant.id;
    const subject = await adminPrisma.subject.create({
      data: { organizationId: orgId, tenantId, type: "HUMAN", name: "Test User 4" }
    });
    subjectId = subject.id;
    const provider = await adminPrisma.providerConnection.create({
      data: { organizationId: orgId, name: "Entra", providerType: "MICROSOFT_ENTRA", externalScopeId: "tid-abc"}
    });
    providerConnectionId = provider.id;
    const identity = await adminPrisma.identityAccount.create({
      data: { organizationId: orgId, tenantId, subjectId, providerConnectionId: provider.id, externalObjectId: "oid-abc" }
    });
    identityAccountId = identity.id;
  });

  afterAll(async () => {
    await rawPrisma.authTransaction.deleteMany({});
    await adminPrisma.session.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.identityAccount.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.subject.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.tenant.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.providerConnection.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.organization.deleteMany({ where: { id: orgId } });
  });

  it("should reject if no cookies found (no state)", async () => {
    const req = new NextRequest("http://localhost:3000/auth/callback?code=abc&state=def");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("should reject if state does not match", async () => {
    const req = new NextRequest("http://localhost:3000/auth/callback?code=abc&state=wrong_state");
    req.cookies.set("oidc_state", "some_state");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("should reject if transaction not found in DB", async () => {
    const req = new NextRequest("http://localhost:3000/auth/callback?code=abc&state=valid_state");
    req.cookies.set("oidc_state", "valid_state");
    req.cookies.set("oidc_code_verifier", "verifier");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("should process valid transaction and set session cookie", async () => {
    await AuthTransactionStore.createTransaction({
      stateHash: "valid_state",
      nonce: "nonce",
      codeVerifier: "verifier",
      expectedOrganizationId: orgId,
      expectedTenantId: tenantId,
      expectedProviderConnectionId: providerConnectionId,
      returnTo: "/dashboard"
    });

    const req = new NextRequest("http://localhost:3000/auth/callback?code=abc&state=valid_state");
    req.cookies.set("oidc_state", "valid_state");
    req.cookies.set("oidc_code_verifier", "verifier");

    const res = await GET(req);
    expect(res.status).toBe(307);
    
    expect(mockCookieSet).toHaveBeenCalledWith(
      "luxia_session",
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        secure: expect.any(Boolean),
        sameSite: "lax",
      })
    );
  });

  it("should reject replayed OIDC state", async () => {
    const req = new NextRequest("http://localhost:3000/auth/callback?code=abc&state=valid_state");
    req.cookies.set("oidc_state", "valid_state");
    req.cookies.set("oidc_code_verifier", "verifier");

    const res = await GET(req);
    expect(res.status).toBe(400); // Because it was already consumed
  });
});
