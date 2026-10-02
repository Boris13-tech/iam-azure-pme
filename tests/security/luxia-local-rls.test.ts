import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import { adminPrisma } from "../helpers/admin-prisma";

describe("LUXIA_LOCAL PostgreSQL tenant isolation", () => {
  const org = randomUUID(), tenantA = randomUUID(), tenantB = randomUUID(), provider = randomUUID();
  const subjectA = randomUUID(), subjectB = randomUUID(), accountA = randomUUID(), accountB = randomUUID();
  beforeAll(async () => {
    await adminPrisma.organization.create({ data: { id: org, name: "Local RLS Org" } });
    await adminPrisma.tenant.createMany({ data: [{ id: tenantA, organizationId: org, name: "A" }, { id: tenantB, organizationId: org, name: "B" }] });
    await adminPrisma.providerConnection.create({ data: { id: provider, organizationId: org, providerType: "LUXIA_LOCAL", externalScopeId: "local-rls", name: "Local" } });
    await adminPrisma.subject.createMany({ data: [
      { id: subjectA, organizationId: org, tenantId: tenantA, type: "HUMAN", name: "Alice" },
      { id: subjectB, organizationId: org, tenantId: tenantB, type: "HUMAN", name: "Bob" },
    ] });
    await adminPrisma.identityAccount.createMany({ data: [
      { id: accountA, organizationId: org, tenantId: tenantA, subjectId: subjectA, providerConnectionId: provider, externalObjectId: "local-a" },
      { id: accountB, organizationId: org, tenantId: tenantB, subjectId: subjectB, providerConnectionId: provider, externalObjectId: "local-b" },
    ] });
    await adminPrisma.localIdentity.createMany({ data: [
      { organizationId: org, tenantId: tenantA, identityAccountId: accountA, principalName: "alice" },
      { organizationId: org, tenantId: tenantB, identityAccountId: accountB, principalName: "bob" },
    ] });
    await adminPrisma.localAuthenticator.createMany({ data: [
      { organizationId: org, tenantId: tenantA, identityAccountId: accountA, type: "TOTP", secretRef: "vault://a" },
      { organizationId: org, tenantId: tenantB, identityAccountId: accountB, type: "TOTP", secretRef: "vault://b" },
    ] });
    await adminPrisma.localAuthChallenge.createMany({ data: [
      { organizationId: org, tenantId: tenantA, identityAccountId: accountA, purpose: "AUTHENTICATION", challengeHash: "hash-a", expiresAt: new Date(Date.now() + 60000) },
      { organizationId: org, tenantId: tenantB, identityAccountId: accountB, purpose: "AUTHENTICATION", challengeHash: "hash-b", expiresAt: new Date(Date.now() + 60000) },
    ] });
    await adminPrisma.localRecoveryCode.createMany({ data: [
      { organizationId: org, tenantId: tenantA, identityAccountId: accountA, codeHash: "recovery-a" },
      { organizationId: org, tenantId: tenantB, identityAccountId: accountB, codeHash: "recovery-b" },
    ] });
  });
  afterAll(async () => {
    await adminPrisma.localRecoveryCode.deleteMany({ where: { organizationId: org } });
    await adminPrisma.localAuthChallenge.deleteMany({ where: { organizationId: org } });
    await adminPrisma.localAuthenticator.deleteMany({ where: { organizationId: org } });
    await adminPrisma.localIdentity.deleteMany({ where: { organizationId: org } });
    await adminPrisma.identityAccount.deleteMany({ where: { organizationId: org } }); await adminPrisma.subject.deleteMany({ where: { organizationId: org } });
    await adminPrisma.providerConnection.deleteMany({ where: { organizationId: org } }); await adminPrisma.tenant.deleteMany({ where: { organizationId: org } }); await adminPrisma.organization.deleteMany({ where: { id: org } });
  });

  it("shows each of the four new tables only inside its tenant", async () => {
    const counts = await withTenantDb({ organizationId: org, tenantId: tenantA }, async (tx) => Promise.all([
      tx.localIdentity.count(), tx.localAuthenticator.count(), tx.localAuthChallenge.count(), tx.localRecoveryCode.count(),
    ]));
    expect(counts).toEqual([1, 1, 1, 1]);
  });

  it("rejects a cross-tenant write on every new table", async () => {
    await withTenantDb({ organizationId: org, tenantId: tenantA }, async (tx) => {
      await expect(tx.localIdentity.create({ data: { organizationId: org, tenantId: tenantB, identityAccountId: accountB, principalName: "intruder" } })).rejects.toThrow();
      await expect(tx.localAuthenticator.create({ data: { organizationId: org, tenantId: tenantB, identityAccountId: accountB, type: "TOTP", secretRef: "vault://intruder" } })).rejects.toThrow();
      await expect(tx.localAuthChallenge.create({ data: { organizationId: org, tenantId: tenantB, identityAccountId: accountB, purpose: "AUTHENTICATION", challengeHash: "intruder", expiresAt: new Date(Date.now() + 60000) } })).rejects.toThrow();
      await expect(tx.localRecoveryCode.create({ data: { organizationId: org, tenantId: tenantB, identityAccountId: accountB, codeHash: "intruder" } })).rejects.toThrow();
    });
  });
});
