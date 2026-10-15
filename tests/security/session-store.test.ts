import { adminPrisma } from "../helpers/admin-prisma";
import { purgeTestOrganization } from "../helpers/purge-test-organization";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SessionCreationDeniedError, SessionStore } from "../../lib/auth/session-store";
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
      data: { organizationId: orgId, name: "Entra", providerType: "MICROSOFT_ENTRA", externalScopeId: `scope-${orgId}`}
    });

    const identity = await adminPrisma.identityAccount.create({
      data: { organizationId: orgId, tenantId, subjectId, providerConnectionId: provider.id, externalObjectId: "oid-123" }
    });
    identityAccountId = identity.id;
  });

  afterAll(async () => {
    // F2: connections are never deleted outside a test database's superuser purge.
    await purgeTestOrganization(async (tx) => {
      await tx.session.deleteMany({ where: { organizationId: orgId } });
      await tx.identityAccount.deleteMany({ where: { organizationId: orgId } });
      await tx.subject.deleteMany({ where: { organizationId: orgId } });
      await tx.tenant.deleteMany({ where: { organizationId: orgId } });
      await tx.providerConnection.deleteMany({ where: { organizationId: orgId } });
      await tx.organization.deleteMany({ where: { id: orgId } });
    });
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
    // Sessions are append-only (expiresAt is immutable), so the expired session is created expired,
    // directly in DB with adminPrisma, under the hash of a known browser token.
    const rawToken = crypto.randomBytes(32).toString("hex");
    await adminPrisma.session.create({
      data: {
        id: crypto.createHash("sha256").update(rawToken).digest("hex"),
        organizationId: orgId, tenantId, subjectId, identityAccountId,
        expiresAt: new Date(Date.now() - 1000)
      }
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

  it("fails closed when the identity account is disabled", async () => {
    await adminPrisma.identityAccount.update({
      where: { id: identityAccountId },
      data: { status: "DISABLED", disabledAt: new Date() },
    });

    await expect(SessionStore.createSession({
      organizationId: orgId, tenantId, subjectId, identityAccountId,
    })).rejects.toBeInstanceOf(SessionCreationDeniedError);

    await adminPrisma.identityAccount.update({
      where: { id: identityAccountId },
      data: { status: "ACTIVE", disabledAt: null },
    });
  });

  it("fails closed when the canonical subject is not active", async () => {
    await adminPrisma.subject.update({
      where: { id: subjectId },
      data: { lifecycleState: "SUSPENDED", lifecycleVersion: { increment: 1 }, lifecycleChangedAt: new Date() },
    });

    await expect(SessionStore.createSession({
      organizationId: orgId, tenantId, subjectId, identityAccountId,
    })).rejects.toMatchObject({ reason: "SUBJECT_NOT_ACTIVE" });

    await adminPrisma.subject.update({
      where: { id: subjectId },
      data: { lifecycleState: "ACTIVE", lifecycleVersion: { increment: 1 }, lifecycleChangedAt: new Date() },
    });
  });
});
