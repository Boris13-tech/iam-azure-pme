import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { getAuthContext } from "../../lib/auth/auth-context";
import { requireAuth } from "../../lib/auth/require-auth";
import { SessionStore } from "../../lib/auth/session-store";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { cookies } from "next/headers";

// Mock next/headers
vi.mock("next/headers", () => ({
  cookies: vi.fn()
}));

describe("AuthContext Security", () => {
  let orgId: string;
  let tenantId: string;
  let subjectId: string;
  let identityAccountId: string;

  beforeAll(async () => {
    const org = await rawPrisma.organization.create({ data: { name: "Test Org 2" } });
    orgId = org.id;

    const tenant = await rawPrisma.tenant.create({ data: { organizationId: orgId, name: "Test Tenant 2" } });
    tenantId = tenant.id;

    const subject = await rawPrisma.subject.create({
      data: { organizationId: orgId, tenantId, type: "HUMAN", name: "Test User 2" }
    });
    subjectId = subject.id;

    const provider = await rawPrisma.providerConnection.create({
      data: { organizationId: orgId, providerType: "MICROSOFT_ENTRA", externalScopeId: "tid-456", name: "Entra 2" }
    });

    const identity = await rawPrisma.identityAccount.create({
      data: { organizationId: orgId, subjectId, providerConnectionId: provider.id, externalObjectId: "oid-456" }
    });
    identityAccountId = identity.id;
  });

  afterAll(async () => {
    await rawPrisma.session.deleteMany({ where: { organizationId: orgId } });
    await rawPrisma.identityAccount.deleteMany({ where: { organizationId: orgId } });
    await rawPrisma.subject.deleteMany({ where: { organizationId: orgId } });
    await rawPrisma.tenant.deleteMany({ where: { organizationId: orgId } });
    await rawPrisma.providerConnection.deleteMany({ where: { organizationId: orgId } });
    await rawPrisma.organization.deleteMany({ where: { id: orgId } });
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
