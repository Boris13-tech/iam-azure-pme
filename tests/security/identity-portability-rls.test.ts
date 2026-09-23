import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import { adminPrisma } from "../helpers/admin-prisma";

describe("Phase 6G portability and recovery tenant isolation", () => {
  const org = randomUUID(), tenantA = randomUUID(), tenantB = randomUUID(), subjectA = randomUUID(), subjectB = randomUUID();
  const receipts = new Map<string, string>(), ceremonies = new Map<string, string>();
  beforeAll(async () => {
    await adminPrisma.organization.create({ data: { id: org, name: "Portability RLS" } });
    await adminPrisma.tenant.createMany({ data: [{ id: tenantA, organizationId: org, name: "A" }, { id: tenantB, organizationId: org, name: "B" }] });
    await adminPrisma.subject.createMany({ data: [
      { id: subjectA, organizationId: org, tenantId: tenantA, type: "HUMAN", name: "A" },
      { id: subjectB, organizationId: org, tenantId: tenantB, type: "HUMAN", name: "B" },
    ] });
    for (const [tenantId, subjectId] of [[tenantA, subjectA], [tenantB, subjectB]] as const) {
      const receipt = await adminPrisma.identityPortabilityReceipt.create({ data: { organizationId: org, tenantId,
        packageId: `package-${tenantId}`, direction: "IMPORT", manifestDigest: `sha256:${tenantId}`, recoveryEpoch: 0 } });
      const ceremony = await adminPrisma.identityRecoveryCeremony.create({ data: { organizationId: org, tenantId,
        packageId: `package-${tenantId}`, manifestDigest: `sha256:${tenantId}`, epochFrom: 0, epochTo: 1,
        requiredApprovals: 2, isolatedEnvironment: true } });
      receipts.set(tenantId, receipt.id); ceremonies.set(tenantId, ceremony.id);
      await adminPrisma.identityRecoveryApproval.create({ data: { organizationId: org, tenantId, ceremonyId: ceremony.id,
        authorityId: "authority-a", evidenceDigest: `sha256:approval-${tenantId}` } });
      await adminPrisma.identityPortabilityConflict.create({ data: { organizationId: org, tenantId, receiptId: receipt.id,
        entityType: "SUBJECT", entityId: subjectId, existingDigest: "sha256:old", incomingDigest: "sha256:new", reasonCode: "CONFLICT" } });
      await adminPrisma.credentialReenrollmentRequirement.create({ data: { organizationId: org, tenantId, subjectId,
        originalCredentialId: `credential-${tenantId}`, recoveryEpoch: 1, reasonCode: "NON_EXPORTABLE_AUTHENTICATOR" } });
    }
  });
  afterAll(async () => {
    await adminPrisma.credentialReenrollmentRequirement.deleteMany({ where: { organizationId: org } });
    await adminPrisma.identityPortabilityConflict.deleteMany({ where: { organizationId: org } });
    await adminPrisma.identityRecoveryApproval.deleteMany({ where: { organizationId: org } });
    await adminPrisma.identityRecoveryCeremony.deleteMany({ where: { organizationId: org } });
    await adminPrisma.identityPortabilityReceipt.deleteMany({ where: { organizationId: org } });
    await adminPrisma.subject.deleteMany({ where: { organizationId: org } });
    await adminPrisma.tenant.deleteMany({ where: { organizationId: org } });
    await adminPrisma.organization.deleteMany({ where: { id: org } });
  });

  it("exposes only the active tenant across every recovery table", async () => {
    const counts = await withTenantDb({ organizationId: org, tenantId: tenantA }, (tx) => Promise.all([
      tx.identityPortabilityReceipt.count(), tx.identityRecoveryCeremony.count(), tx.identityRecoveryApproval.count(),
      tx.identityPortabilityConflict.count(), tx.credentialReenrollmentRequirement.count(),
    ]));
    expect(counts).toEqual([1, 1, 1, 1, 1]);
  });

  it("rejects cross-tenant recovery and reenrollment writes", async () => {
    await withTenantDb({ organizationId: org, tenantId: tenantA }, async (tx) => {
      await expect(tx.identityRecoveryApproval.create({ data: { organizationId: org, tenantId: tenantB,
        ceremonyId: ceremonies.get(tenantB)!, authorityId: "intruder", evidenceDigest: "sha256:intruder" } })).rejects.toThrow();
      await expect(tx.credentialReenrollmentRequirement.create({ data: { organizationId: org, tenantId: tenantB,
        subjectId: subjectB, originalCredentialId: "intruder", recoveryEpoch: 1, reasonCode: "INTRUDER" } })).rejects.toThrow();
    });
  });
});
