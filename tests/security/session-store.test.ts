import { adminPrisma } from "../helpers/admin-prisma";
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
    const org = await adminPrisma.organization.create({ data: { name: "Test Org" } });
    orgId = org.id;

    const tenant = await adminPrisma.tenant.create({ data: { organizationId: orgId, name: "Test Tenant" } });
    tenantId = tenant.id;

    const subject = await adminPrisma.subject.create({
      data: { organizationId: orgId, tenantId, type: "HUMAN", name: "Test User" }
    });
    subjectId = subject.id;

    const provider = await adminPrisma.providerConnection.create({
      data: { organizationId: orgId, name: "Entra" }
    });

    const identity = await adminPrisma.identityAccount.create({
      data: { organizationId: orgId, tenantId, subjectId, providerConnectionId: provider.id, externalObjectId: "oid-123" }
    });
    identityAccountId = identity.id;
  });

  afterAll(async () => {
    await adminPrisma.session.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.identityAccount.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.subject.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.tenant.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.providerConnection.deleteMany({ where: { organizationId: orgId } });
    await adminPrisma.organization.deleteMany({ where: { id: orgId } });
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
