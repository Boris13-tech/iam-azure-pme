import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import { adminPrisma } from "../helpers/admin-prisma";

describe("Phase 6E key and trust-anchor tenant isolation", () => {
  const org = randomUUID(), tenantA = randomUUID(), tenantB = randomUUID();
  beforeAll(async () => {
    await adminPrisma.organization.create({ data: { id: org, name: "Crypto RLS Org" } });
    await adminPrisma.tenant.createMany({ data: [{ id: tenantA, organizationId: org, name: "A" }, { id: tenantB, organizationId: org, name: "B" }] });
    for (const tenantId of [tenantA, tenantB]) {
      await adminPrisma.cryptoKeyVersion.create({ data: { organizationId: org, tenantId, logicalKeyId: "evidence", version: 1,
        purpose: "EVIDENCE_SIGNING", algorithmId: "EVIDENCE_ES256", algorithmVersion: 1, status: "ACTIVE", custodyRef: `custody://${tenantId}` } });
      await adminPrisma.trustAnchorVersion.create({ data: { organizationId: org, tenantId, trustAnchorId: "root", version: 1,
        algorithmId: "EVIDENCE_ES256", algorithmVersion: 1, status: "ACTIVE", publicMaterial: `public-${tenantId}`,
        fingerprint: `fingerprint-${tenantId}`, validFrom: new Date("2026-09-23T00:00:00.000Z") } });
    }
  });
  afterAll(async () => {
    await adminPrisma.trustAnchorVersion.deleteMany({ where: { organizationId: org } });
    await adminPrisma.cryptoKeyVersion.deleteMany({ where: { organizationId: org } });
    await adminPrisma.tenant.deleteMany({ where: { organizationId: org } });
    await adminPrisma.organization.deleteMany({ where: { id: org } });
  });

  it("exposes only the current tenant's key and anchor versions", async () => {
    const counts = await withTenantDb({ organizationId: org, tenantId: tenantA }, (tx) => Promise.all([
      tx.cryptoKeyVersion.count(), tx.trustAnchorVersion.count(),
    ]));
    expect(counts).toEqual([1, 1]);
  });

  it("rejects cross-tenant key and anchor writes", async () => {
    await withTenantDb({ organizationId: org, tenantId: tenantA }, async (tx) => {
      await expect(tx.cryptoKeyVersion.create({ data: { organizationId: org, tenantId: tenantB, logicalKeyId: "intruder", version: 1,
        purpose: "EVIDENCE_SIGNING", algorithmId: "EVIDENCE_ES256", algorithmVersion: 1, custodyRef: "custody://intruder" } })).rejects.toThrow();
      await expect(tx.trustAnchorVersion.create({ data: { organizationId: org, tenantId: tenantB, trustAnchorId: "intruder", version: 1,
        algorithmId: "EVIDENCE_ES256", algorithmVersion: 1, publicMaterial: "public", fingerprint: "intruder", validFrom: new Date() } })).rejects.toThrow();
    });
  });
});
