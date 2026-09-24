import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import { PrismaDirectoryProjectionStore } from "../../lib/provider-adapters/implementations/enterprise-directory";
import { adminPrisma } from "../helpers/admin-prisma";

describe("Phase 6H enterprise directory tenant isolation", () => {
  const org = randomUUID(), tenantA = randomUUID(), tenantB = randomUUID(), subjectA = randomUUID(), subjectB = randomUUID(), connection = randomUUID();
  const context = (tenantId: string, operationId: string) => ({ organizationId: org, tenantId, providerConnectionId: connection, operationId });
  beforeAll(async () => {
    await adminPrisma.organization.create({ data: { id: org, name: "Directory RLS" } });
    await adminPrisma.tenant.createMany({ data: [{ id: tenantA, organizationId: org, name: "A" }, { id: tenantB, organizationId: org, name: "B" }] });
    await adminPrisma.subject.createMany({ data: [
      { id: subjectA, organizationId: org, tenantId: tenantA, type: "HUMAN", name: "Alice" },
      { id: subjectB, organizationId: org, tenantId: tenantB, type: "HUMAN", name: "Bob" },
    ] });
    await adminPrisma.providerConnection.create({ data: { id: connection, organizationId: org, providerType: "LDAP",
      externalScopeId: "dc=example,dc=internal", name: "Read-only LDAP" } });
    for (const [tenantId, externalObjectId] of [[tenantA, "collision-a"], [tenantB, "collision-b"]] as const)
      await adminPrisma.providerIdentityCollision.create({ data: { organizationId: org, tenantId, providerConnectionId: connection,
        externalObjectId, reasonCode: "DUPLICATE_EXTERNAL_ID", evidence: { reason: "test" } } });
  });
  afterAll(async () => {
    await adminPrisma.providerIdentityCollision.deleteMany({ where: { organizationId: org } });
    await adminPrisma.identityAccount.deleteMany({ where: { organizationId: org } });
    await adminPrisma.providerConnection.deleteMany({ where: { organizationId: org } });
    await adminPrisma.subject.deleteMany({ where: { organizationId: org } });
    await adminPrisma.tenant.deleteMany({ where: { organizationId: org } });
    await adminPrisma.organization.deleteMany({ where: { id: org } });
  });

  it("links and replays one provider projection without changing the canonical Subject", async () => {
    const store = new PrismaDirectoryProjectionStore();
    const first = await store.link(context(tenantA, "link-one"), { providerType: "LDAP", subjectId: subjectA, externalObjectId: "immutable-alice" });
    const replay = await store.link(context(tenantA, "link-two"), { providerType: "LDAP", subjectId: subjectA, externalObjectId: "immutable-alice" });
    expect(first).toMatchObject({ subjectId: subjectA, created: true }); expect(replay).toMatchObject({ identityAccountId: first.identityAccountId, created: false });
    expect(await adminPrisma.subject.findUnique({ where: { id: subjectA } })).toMatchObject({ id: subjectA, name: "Alice" });
  });

  it("forbids cross-tenant account reuse and isolates collision evidence", async () => {
    const store = new PrismaDirectoryProjectionStore();
    await expect(store.link(context(tenantB, "cross-tenant"), { providerType: "LDAP", subjectId: subjectB,
      externalObjectId: "immutable-alice" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(withTenantDb({ organizationId: org, tenantId: tenantA }, (tx) => tx.providerIdentityCollision.count())).resolves.toBe(1);
    await withTenantDb({ organizationId: org, tenantId: tenantA }, async (tx) => {
      await expect(tx.providerIdentityCollision.create({ data: { organizationId: org, tenantId: tenantB,
        providerConnectionId: connection, externalObjectId: "intruder", reasonCode: "AMBIGUOUS_SUBJECT_MAPPING", evidence: {} } })).rejects.toThrow();
    });
  });
});
