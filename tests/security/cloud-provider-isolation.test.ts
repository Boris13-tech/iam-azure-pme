import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaCloudProjectionStore } from "../../lib/provider-adapters/implementations/cloud-providers";
import { adminPrisma } from "../helpers/admin-prisma";

describe("Phase 6I cloud projection tenant isolation", () => {
  const org = randomUUID(), tenantA = randomUUID(), tenantB = randomUUID(), subjectA = randomUUID(), subjectB = randomUUID(), connection = randomUUID();
  const context = (tenantId: string, operationId: string) => ({ organizationId: org, tenantId, providerConnectionId: connection, operationId });
  beforeAll(async () => {
    await adminPrisma.organization.create({ data: { id: org, name: "Cloud projection RLS" } });
    await adminPrisma.tenant.createMany({ data: [{ id: tenantA, organizationId: org, name: "A" }, { id: tenantB, organizationId: org, name: "B" }] });
    await adminPrisma.subject.createMany({ data: [
      { id: subjectA, organizationId: org, tenantId: tenantA, type: "HUMAN", name: "Alice" },
      { id: subjectB, organizationId: org, tenantId: tenantB, type: "HUMAN", name: "Bob" },
    ] });
    await adminPrisma.providerConnection.create({ data: { id: connection, organizationId: org, providerType: "GOOGLE_WORKSPACE",
      externalScopeId: "customer-1", name: "Google read-only" } });
  });
  afterAll(async () => {
    await adminPrisma.identityAccount.deleteMany({ where: { organizationId: org } });
    await adminPrisma.providerConnection.deleteMany({ where: { organizationId: org } });
    await adminPrisma.subject.deleteMany({ where: { organizationId: org } });
    await adminPrisma.tenant.deleteMany({ where: { organizationId: org } });
    await adminPrisma.organization.deleteMany({ where: { id: org } });
  });
  it("creates an idempotent tenant-scoped projection and preserves Subject", async () => {
    const store = new PrismaCloudProjectionStore(); const input = { providerType: "GOOGLE_WORKSPACE" as const,
      subjectId: subjectA, externalObjectId: "google_workspace:identity:1001" };
    const first = await store.link(context(tenantA, "first"), input); const replay = await store.link(context(tenantA, "replay"), input);
    expect(first).toMatchObject({ subjectId: subjectA, created: true }); expect(replay).toMatchObject({ identityAccountId: first.identityAccountId, created: false });
    expect(await adminPrisma.subject.findUnique({ where: { id: subjectA } })).toMatchObject({ id: subjectA, lifecycleState: "ACTIVE" });
  });
  it("rejects cross-tenant projection collisions", async () => {
    const store = new PrismaCloudProjectionStore();
    await expect(store.link(context(tenantB, "cross"), { providerType: "GOOGLE_WORKSPACE", subjectId: subjectB,
      externalObjectId: "google_workspace:identity:1001" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
