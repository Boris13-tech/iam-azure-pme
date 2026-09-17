import { adminPrisma } from "../../helpers/admin-prisma";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { POST } from "../../app/auth/logout/route";
import { NextRequest } from "next/server";
import { SessionStore } from "../../lib/auth/session-store";
import { rawPrisma } from "../../lib/db/raw-prisma";

describe("Logout Security", () => {
  let orgId: string;
  let tenantId: string;
  let subjectId: string;
  let identityAccountId: string;

  beforeAll(async () => {
    const org = await adminPrisma.organization.create({ data: { name: "Test Org 3" } });
    orgId = org.id;
    const tenant = await adminPrisma.tenant.create({ data: { organizationId: orgId, name: "Test Tenant 3" } });
    tenantId = tenant.id;
    const subject = await adminPrisma.subject.create({
      data: { organizationId: orgId, tenantId, type: "HUMAN", name: "Test User 3" }
    });
    subjectId = subject.id;
    const provider = await adminPrisma.providerConnection.create({
      data: { organizationId: orgId, name: "Entra" }
    });
    const identity = await adminPrisma.identityAccount.create({
      data: { organizationId: orgId, tenantId, subjectId, providerConnectionId: provider.id, externalObjectId: "oid-789" }
    });
    identityAccountId = identity.id;
    
    // Set NEXT_PUBLIC_APP_URL for testing
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  });

  afterAll(async () => {
    await adminPrisma.session.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.identityAccount.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.subject.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.tenant.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.providerConnection.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.organization.deleteMany({ where: { id: orgId } });
  });

  const createMockRequest = (origin: string, token: string | undefined, federated: boolean = false) => {
    const url = new URL(`http://localhost:3000/auth/logout${federated ? '?federated=true' : ''}`);
    const req = new NextRequest(url, {
      method: "POST",
      headers: new Headers({ origin })
    });
    
    if (token) {
      req.cookies.set("luxia_session", token);
    }
    
    return req;
  };

  it("should return 403 on wrong origin", async () => {
    const req = createMockRequest("http://evil.com", "fake_token");
    const response = await POST(req);
    expect(response.status).toBe(403);
  });

  it("should revoke session and return 303 to /login on valid session", async () => {
    const { rawToken } = await SessionStore.createSession({
      organizationId: orgId, tenantId, subjectId, identityAccountId
    });

    const req = createMockRequest("http://localhost:3000", rawToken);
    const response = await POST(req);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login");
    
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("luxia_session=");
    expect(setCookie).toContain("Max-Age=0");

    const session = await SessionStore.getSession(rawToken);
    expect(session).toBeNull();
  });

  it("should succeed and clear cookie even if token is fake (idempotent)", async () => {
    const req = createMockRequest("http://localhost:3000", "fake_token");
    const response = await POST(req);

    expect(response.status).toBe(303);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("should succeed and clear cookie even if no token provided", async () => {
    const req = createMockRequest("http://localhost:3000", undefined);
    const response = await POST(req);

    expect(response.status).toBe(303);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("should attempt federated logout if federated=true is passed", async () => {
    const { rawToken } = await SessionStore.createSession({
      organizationId: orgId, tenantId, subjectId, identityAccountId
    });

    // Mock getEntraOIDCConfig
    vi.mock("../../lib/auth/providers/entra", () => ({
      getEntraOIDCConfig: vi.fn().mockResolvedValue({
        config: {
          serverMetadata: () => ({
            end_session_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/logout"
          })
        }
      })
    }));

    const req = createMockRequest("http://localhost:3000", rawToken, true);
    const response = await POST(req);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("microsoftonline.com");
    expect(response.headers.get("location")).toContain("post_logout_redirect_uri=");
    
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("Max-Age=0");

    const session = await SessionStore.getSession(rawToken);
    expect(session).toBeNull();
  });
});
