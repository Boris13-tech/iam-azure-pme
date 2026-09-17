import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { GET } from "../../app/auth/callback/route";
import { NextRequest } from "next/server";
import { rawPrisma } from "../../lib/db/raw-prisma";
import crypto from "crypto";
import { AuthTransactionStore } from "../../lib/auth/auth-transaction-store";

vi.mock("../../lib/auth/providers/entra", () => ({
  getEntraOIDCConfig: vi.fn().mockResolvedValue({
    client: {
      callbackParams: () => ({ code: "auth_code", state: "valid_state" }),
      callback: () => ({
        claims: () => ({
          iss: "https://login.microsoftonline.com/tid-abc/v2.0",
          tid: "tid-abc",
          oid: "oid-abc",
          email: "test@example.com"
        })
      })
    },
    redirectUri: "http://localhost:3000/auth/callback"
  })
}));

describe("OIDC Callback Security", () => {
  let orgId: string;
  let tenantId: string;
  let subjectId: string;
  let identityAccountId: string;
  let providerConnectionId: string;

  beforeAll(async () => {
    const org = await rawPrisma.organization.create({ data: { name: "Test Org 4" } });
    orgId = org.id;
    const tenant = await rawPrisma.tenant.create({ data: { organizationId: orgId, name: "Test Tenant 4" } });
    tenantId = tenant.id;
    const subject = await rawPrisma.subject.create({
      data: { organizationId: orgId, tenantId, type: "HUMAN", name: "Test User 4" }
    });
    subjectId = subject.id;
    const provider = await rawPrisma.providerConnection.create({
      data: { organizationId: orgId, providerType: "MICROSOFT_ENTRA", externalScopeId: "tid-abc", name: "Entra 4" }
    });
    providerConnectionId = provider.id;
    const identity = await rawPrisma.identityAccount.create({
      data: { organizationId: orgId, subjectId, providerConnectionId: provider.id, externalObjectId: "oid-abc" }
    });
    identityAccountId = identity.id;
  });

  afterAll(async () => {
    await rawPrisma.authTransaction.deleteMany({});
    await rawPrisma.session.deleteMany({ where: { organizationId: orgId } });
    await rawPrisma.identityAccount.deleteMany({ where: { organizationId: orgId } });
    await rawPrisma.subject.deleteMany({ where: { organizationId: orgId } });
    await rawPrisma.tenant.deleteMany({ where: { organizationId: orgId } });
    await rawPrisma.providerConnection.deleteMany({ where: { organizationId: orgId } });
    await rawPrisma.organization.deleteMany({ where: { id: orgId } });
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
    await AuthTransactionStore.createTransaction(
      "valid_state",
      "nonce",
      "verifier",
      orgId,
      providerConnectionId,
      "/dashboard"
    );

    const req = new NextRequest("http://localhost:3000/auth/callback?code=abc&state=valid_state");
    req.cookies.set("oidc_state", "valid_state");
    req.cookies.set("oidc_code_verifier", "verifier");

    const res = await GET(req);
    expect(res.status).toBe(303);
    
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("luxia_session=");
  });

  it("should reject replayed OIDC state", async () => {
    const req = new NextRequest("http://localhost:3000/auth/callback?code=abc&state=valid_state");
    req.cookies.set("oidc_state", "valid_state");
    req.cookies.set("oidc_code_verifier", "verifier");

    const res = await GET(req);
    expect(res.status).toBe(400); // Because it was already consumed
  });
});
