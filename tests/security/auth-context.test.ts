import { adminPrisma } from "../helpers/admin-prisma";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { getAuthContext } from "../../lib/auth/auth-context";
import { requireAuth } from "../../lib/auth/require-auth";
import { SessionStore } from "../../lib/auth/session-store";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { cookies } from "next/headers";

// Mock next/headers
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
  headers: vi.fn()
}));

describe("AuthContext Security", () => {
  let orgId: string;
  let tenantId: string;
  let subjectId: string;
  let identityAccountId: string;

  beforeAll(async () => {
    const org = await adminPrisma.organization.create({ data: { name: "Test Org 2" } });
    orgId = org.id;

    const tenant = await adminPrisma.tenant.create({ data: { organizationId: orgId, name: "Test Tenant 2" } });
    tenantId = tenant.id;

    const subject = await adminPrisma.subject.create({
      data: { organizationId: orgId, tenantId, type: "HUMAN", name: "Test User 2" }
    });
    subjectId = subject.id;

    const provider = await adminPrisma.providerConnection.create({
      data: { organizationId: orgId, name: "Entra", providerType: "MICROSOFT_ENTRA", externalScopeId: `scope-${orgId}`}
    });

    const identity = await adminPrisma.identityAccount.create({
      data: { organizationId: orgId, tenantId, subjectId, providerConnectionId: provider.id, externalObjectId: "oid-456" }
    });
    identityAccountId = identity.id;
  });

  afterAll(async () => {
    await adminPrisma.assignment.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.session.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.identityAccount.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.legacyUserBridge.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.subject.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.tenant.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.providerConnection.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.organization.deleteMany({ where: { id: orgId } });
  });


  it("should return null AuthContext if no cookie", async () => {
    (cookies as any).mockReturnValue({
      get: () => undefined
    });

    const auth = await getAuthContext();
    expect(auth).toBeNull();
  });

  it("requireAuth should throw UNAUTHORIZED if no cookie", async () => {
    (cookies as any).mockReturnValue({
      get: () => undefined
    });

    await expect(requireAuth()).rejects.toThrow("UNAUTHORIZED");
  });

  it("should return valid AuthContext with correct boundaries", async () => {
    const { rawToken } = await SessionStore.createSession({
      organizationId: orgId, tenantId, subjectId, identityAccountId
    });

    (cookies as any).mockReturnValue({
      get: (name: string) => name === "luxia_session" ? { value: rawToken } : undefined
    });

    const auth = await getAuthContext();
    expect(auth).toBeDefined();
    expect(auth?.organizationId).toBe(orgId);
    expect(auth?.tenantId).toBe(tenantId);
    expect(auth?.subjectId).toBe(subjectId);
  });

  it("should return null for revoked session", async () => {
    const { rawToken } = await SessionStore.createSession({
      organizationId: orgId, tenantId, subjectId, identityAccountId
    });

    await SessionStore.revokeByToken(rawToken);

    (cookies as any).mockReturnValue({
      get: (name: string) => name === "luxia_session" ? { value: rawToken } : undefined
    });

    const auth = await getAuthContext();
    expect(auth).toBeNull();
  });
});
