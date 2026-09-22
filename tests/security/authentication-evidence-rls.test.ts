import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import { adminPrisma } from "../helpers/admin-prisma";

describe("Phase 6D authentication evidence RLS", () => {
  const org = randomUUID(), tenantA = randomUUID(), tenantB = randomUUID(), provider = randomUUID();
  const subjectA = randomUUID(), subjectB = randomUUID(), accountA = randomUUID(), accountB = randomUUID();
  beforeAll(async () => {
    await adminPrisma.organization.create({ data: { id: org, name: "Evidence RLS Org" } });
    await adminPrisma.tenant.createMany({ data: [{ id: tenantA, organizationId: org, name: "A" }, { id: tenantB, organizationId: org, name: "B" }] });
    await adminPrisma.providerConnection.create({ data: { id: provider, organizationId: org, providerType: "LUXIA_LOCAL", externalScopeId: "evidence-rls", name: "Evidence" } });
    await adminPrisma.subject.createMany({ data: [
      { id: subjectA, organizationId: org, tenantId: tenantA, type: "HUMAN", name: "Alice" },
      { id: subjectB, organizationId: org, tenantId: tenantB, type: "DEVICE", name: "Device B" },
    ] });
    await adminPrisma.identityAccount.createMany({ data: [
      { id: accountA, organizationId: org, tenantId: tenantA, subjectId: subjectA, providerConnectionId: provider, externalObjectId: "evidence-a" },
      { id: accountB, organizationId: org, tenantId: tenantB, subjectId: subjectB, providerConnectionId: provider, externalObjectId: "evidence-b" },
    ] });
    await adminPrisma.authenticationEvidence.createMany({ data: [evidence(tenantA, subjectA, accountA, "op-a"), evidence(tenantB, subjectB, accountB, "op-b")] });
  });
  afterAll(async () => {
    await adminPrisma.authenticationEvidence.deleteMany({ where: { organizationId: org } });
    await adminPrisma.identityAccount.deleteMany({ where: { organizationId: org } });
    await adminPrisma.subject.deleteMany({ where: { organizationId: org } });
    await adminPrisma.providerConnection.deleteMany({ where: { organizationId: org } });
    await adminPrisma.tenant.deleteMany({ where: { organizationId: org } });
    await adminPrisma.organization.deleteMany({ where: { id: org } });
  });

  it("exposes only evidence in the active tenant", async () => {
    const rows = await withTenantDb({ organizationId: org, tenantId: tenantA }, (tx) => tx.authenticationEvidence.findMany());
    expect(rows).toHaveLength(1); expect(rows[0].subjectId).toBe(subjectA);
  });

  it("rejects cross-tenant evidence insertion", async () => {
    await withTenantDb({ organizationId: org, tenantId: tenantA }, async (tx) => {
      await expect(tx.authenticationEvidence.create({ data: evidence(tenantB, subjectB, accountB, "cross-tenant") })).rejects.toThrow();
    });
  });

  function evidence(tenantId: string, subjectId: string, identityAccountId: string, operationId: string) {
    return {
      organizationId: org, tenantId, subjectId, identityAccountId, providerConnectionId: provider,
      method: "PASSKEY" as const, outcome: "VERIFIED" as const, assuranceLevel: "SUBSTANTIAL" as const,
      assuranceProfile: "local-passkey", assuranceProfileVersion: 1, phishingResistant: true,
      hardwareBound: false, userVerification: "NOT_VERIFIED" as const, source: "LOCAL_VERIFIER" as const,
      sourceRef: "LUXIA_LOCAL", verifierPolicyVersion: 1, operationId,
      reasonCode: "LOCAL_PASSKEY_ASSERTION_VERIFIED", offline: true, occurredAt: new Date(),
    };
  }
});
