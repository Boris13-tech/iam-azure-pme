import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import { adminPrisma } from "../helpers/admin-prisma";

describe("Phase 6F continuity tenant isolation", () => {
  const org = randomUUID(), tenantA = randomUUID(), tenantB = randomUUID(), subjectA = randomUUID(), subjectB = randomUUID();
  const issuedAt = new Date("2026-09-23T12:00:00.000Z"), expiresAt = new Date("2026-09-23T12:05:00.000Z");
  beforeAll(async () => {
    await adminPrisma.organization.create({ data: { id: org, name: "Continuity RLS" } });
    await adminPrisma.tenant.createMany({ data: [{ id: tenantA, organizationId: org, name: "A" }, { id: tenantB, organizationId: org, name: "B" }] });
    await adminPrisma.subject.createMany({ data: [
      { id: subjectA, organizationId: org, tenantId: tenantA, type: "HUMAN", name: "A" },
      { id: subjectB, organizationId: org, tenantId: tenantB, type: "HUMAN", name: "B" },
    ] });
    for (const [tenantId, subjectId] of [[tenantA, subjectA], [tenantB, subjectB]] as const) {
      await adminPrisma.identityContinuityState.create({ data: { organizationId: org, tenantId, mode: "OFFLINE", partitionEpoch: 1, sequence: 2 } });
      await adminPrisma.offlineIdentityChallenge.create({ data: { organizationId: org, tenantId, subjectId, verifierId: "edge", audience: "app", purpose: "auth",
        nonceDigest: `nonce-${tenantId}`, partitionEpoch: 1, continuityMode: "OFFLINE", algorithmId: "EVIDENCE_ES256", algorithmVersion: 1,
        issuerKeyId: "issuer", issuerKeyVersion: 1, challengeSignature: "signature", issuedAt, expiresAt } });
      await adminPrisma.identityAssuranceSnapshot.create({ data: { organizationId: org, tenantId, subjectId, issuer: "edge", audience: "app", purpose: "auth",
        scopeDigest: `scope-${tenantId}`, evidenceDigest: `evidence-${tenantId}`, assuranceProfile: "offline", assuranceLevel: "HIGH",
        partitionEpoch: 1, sequence: 1, lifecycleVersion: 1, credentialStateVersion: 1, algorithmId: "EVIDENCE_ES256", algorithmVersion: 1,
        issuerKeyId: "issuer", issuerKeyVersion: 1, signature: "signature", issuedAt, expiresAt } });
      await adminPrisma.identityContinuityEvent.create({ data: { organizationId: org, tenantId, subjectId, eventType: "OFFLINE_PROOF_VERIFIED", mode: "OFFLINE",
        partitionEpoch: 1, sequence: 1, operationId: `op-${tenantId}`, reasonCode: "VERIFIED", occurredAt: issuedAt } });
      await adminPrisma.identityContinuityConflict.create({ data: { organizationId: org, tenantId, subjectId, entityType: "CREDENTIAL", entityId: `credential-${tenantId}`,
        localVersion: 1, remoteVersion: 2, localDigest: "local", remoteDigest: "remote", reasonCode: "CONFLICT" } });
    }
  });
  afterAll(async () => {
    await adminPrisma.identityContinuityConflict.deleteMany({ where: { organizationId: org } });
    await adminPrisma.identityContinuityEvent.deleteMany({ where: { organizationId: org } });
    await adminPrisma.identityAssuranceSnapshot.deleteMany({ where: { organizationId: org } });
    await adminPrisma.offlineIdentityChallenge.deleteMany({ where: { organizationId: org } });
    await adminPrisma.identityContinuityState.deleteMany({ where: { organizationId: org } });
    await adminPrisma.subject.deleteMany({ where: { organizationId: org } });
    await adminPrisma.tenant.deleteMany({ where: { organizationId: org } });
    await adminPrisma.organization.deleteMany({ where: { id: org } });
  });

  it("exposes only one tenant's continuity state, challenge, snapshot, event and conflict", async () => {
    const counts = await withTenantDb({ organizationId: org, tenantId: tenantA }, (tx) => Promise.all([
      tx.identityContinuityState.count(), tx.offlineIdentityChallenge.count(), tx.identityAssuranceSnapshot.count(),
      tx.identityContinuityEvent.count(), tx.identityContinuityConflict.count(),
    ]));
    expect(counts).toEqual([1, 1, 1, 1, 1]);
  });

  it("rejects a cross-tenant snapshot and replay-state write", async () => {
    await withTenantDb({ organizationId: org, tenantId: tenantA }, async (tx) => {
      await expect(tx.identityContinuityState.create({ data: { organizationId: org, tenantId: tenantB, mode: "OFFLINE", partitionEpoch: 9 } })).rejects.toThrow();
      await expect(tx.identityAssuranceSnapshot.create({ data: { organizationId: org, tenantId: tenantB, subjectId: subjectB,
        issuer: "intruder", audience: "app", purpose: "auth", scopeDigest: "scope-intruder", evidenceDigest: "evidence-intruder",
        assuranceProfile: "offline", assuranceLevel: "HIGH", partitionEpoch: 1, sequence: 9, lifecycleVersion: 1, credentialStateVersion: 1,
        algorithmId: "EVIDENCE_ES256", algorithmVersion: 1, issuerKeyId: "issuer", issuerKeyVersion: 1,
        signature: "signature", issuedAt, expiresAt } })).rejects.toThrow();
    });
  });
});
