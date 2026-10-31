import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPrisma } from "../helpers/admin-prisma";
import { purgeTestOrganization } from "../helpers/purge-test-organization";

// The database refuses a row that links two organizations or tenants, whoever writes it: the owner connection used here
// is not subject to row-level security, so only the composite foreign keys can refuse. Row-level security itself is
// proven as the runtime role in postgres-rls.test.ts.
describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("Composite tenant boundaries (PostgreSQL)", () => {
  const orgA = randomUUID(), orgB = randomUUID(), tenantA = randomUUID(), tenantA2 = randomUUID(), tenantB = randomUUID();
  const providerA = randomUUID(), providerB = randomUUID(), subjectA = randomUUID();
  const provider = (id: string, organizationId: string) => ({ id, organizationId, name: id, providerType: "MICROSOFT_ENTRA" as const, externalScopeId: id });

  beforeAll(async () => {
    await adminPrisma.organization.createMany({ data: [{ id: orgA, name: "Boundary A" }, { id: orgB, name: "Boundary B" }] });
    await adminPrisma.tenant.createMany({ data: [{ id: tenantA, organizationId: orgA, name: "A" }, { id: tenantA2, organizationId: orgA, name: "A2" }, { id: tenantB, organizationId: orgB, name: "B" }] });
    await adminPrisma.providerConnection.createMany({ data: [provider(providerA, orgA), provider(providerB, orgB)] });
    await adminPrisma.subject.create({ data: { id: subjectA, organizationId: orgA, tenantId: tenantA, type: "HUMAN", name: "Alice" } });
  });

  afterAll(async () => {
    const where = { organizationId: { in: [orgA, orgB] } };
    // A provider connection refuses deletion, so the fixtures go through the test-database-only helper.
    await purgeTestOrganization(async (tx) => {
      await tx.resource.deleteMany({ where });
      await tx.identityAccount.deleteMany({ where });
      await tx.subject.deleteMany({ where });
      await tx.providerConnection.deleteMany({ where });
      await tx.tenant.deleteMany({ where });
      await tx.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    });
    await adminPrisma.$disconnect();
  });

  // Each case changes one identifier, so a refusal comes from that link and nothing else.
  const refusedThenAccepted = async (write: (foreign: boolean) => Promise<unknown>) => {
    await expect(write(true)).rejects.toMatchObject({ code: "P2003" });
    await expect(write(false)).resolves.toBeTruthy();
  };

  it("a Subject of one organization cannot sit in another organization's tenant", () => refusedThenAccepted((foreign) =>
    adminPrisma.subject.create({ data: { organizationId: orgA, tenantId: foreign ? tenantB : tenantA, type: "HUMAN", name: "Bob" } })));

  it("an IdentityAccount cannot link a Subject to another organization's provider", () => refusedThenAccepted((foreign) =>
    adminPrisma.identityAccount.create({ data: { organizationId: orgA, tenantId: tenantA, subjectId: subjectA, providerConnectionId: foreign ? providerB : providerA, externalObjectId: randomUUID() } })));

  it("an IdentityAccount cannot attach to a Subject of another tenant", () => refusedThenAccepted((foreign) =>
    adminPrisma.identityAccount.create({ data: { organizationId: orgA, tenantId: foreign ? tenantA2 : tenantA, subjectId: subjectA, providerConnectionId: providerA, externalObjectId: randomUUID() } })));

  it("a Resource cannot sit in another organization's tenant", () => refusedThenAccepted((foreign) =>
    adminPrisma.resource.create({ data: { organizationId: orgA, tenantId: foreign ? tenantB : tenantA, name: randomUUID(), type: "API" } })));

  it("a Resource cannot name another organization's provider", () => refusedThenAccepted((foreign) =>
    adminPrisma.resource.create({ data: { organizationId: orgA, tenantId: tenantA, name: randomUUID(), type: "API", providerConnectionId: foreign ? providerB : providerA } })));
});
