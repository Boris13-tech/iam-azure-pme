import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SessionStore } from "../../lib/auth/session-store";
import { rawPrisma } from "../../lib/db/raw-prisma";
import crypto from "crypto";

describe("SessionStore Security", () => {
  let orgId: string;
  let tenantId: string;
  let subjectId: string;
  let identityAccountId: string;

  beforeAll(async () => {
    const org = await rawPrisma.organization.create({ data: { name: "Test Org" } });
    orgId = org.id;

    const tenant = await rawPrisma.tenant.create({ data: { organizationId: orgId, name: "Test Tenant" } });
    tenantId = tenant.id;

    const subject = await rawPrisma.subject.create({
      data: { organizationId: orgId, tenantId, type: "HUMAN", name: "Test User" }
    });
    subjectId = subject.id;

    const provider = await rawPrisma.providerConnection.create({
      data: { organizationId: orgId, providerType: "MICROSOFT_ENTRA", externalScopeId: "tid-123", name: "Entra" }
    });

    const identity = await rawPrisma.identityAccount.create({
      data: { organizationId: orgId, subjectId, providerConnectionId: provider.id, externalObjectId: "oid-123" }
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

  it("should create a session, returning a raw token and saving a hashed ID", async () => {
    const { session, rawToken } = await SessionStore.createSession({
      organizationId: orgId,
      tenantId,
      subjectId,
      identityAccountId
    });

    expect(rawToken).toBeDefined();
    expect(session.id).not.toEqual(rawToken);

    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    expect(session.id).toEqual(hashedToken);
  });

  it("should retrieve a valid session using the raw token", async () => {
    const { rawToken } = await SessionStore.createSession({
      organizationId: orgId, tenantId, subjectId, identityAccountId
    });

    const session = await SessionStore.getSession(rawToken);
    expect(session).toBeDefined();
    expect(session?.subjectId).toEqual(subjectId);
  });

  it("should return null for an expired session", async () => {
    const { rawToken, session } = await SessionStore.createSession({
      organizationId: orgId, tenantId, subjectId, identityAccountId
    });

    // Manually expire the session in DB
    await rawPrisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });

    const retrieved = await SessionStore.getSession(rawToken);
    expect(retrieved).toBeNull();
  });

  it("should return null for a revoked session", async () => {
    const { rawToken } = await SessionStore.createSession({
      organizationId: orgId, tenantId, subjectId, identityAccountId
    });

    await SessionStore.revokeByToken(rawToken);

    const retrieved = await SessionStore.getSession(rawToken);
    expect(retrieved).toBeNull();
  });

  it("should return null for a modified or fake token", async () => {
    const { rawToken } = await SessionStore.createSession({
      organizationId: orgId, tenantId, subjectId, identityAccountId
    });

    const fakeToken = rawToken + "a";
    const retrieved = await SessionStore.getSession(fakeToken);
    expect(retrieved).toBeNull();
  });
});
