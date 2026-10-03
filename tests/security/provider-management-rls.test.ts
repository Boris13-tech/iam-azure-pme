import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPrisma } from "../helpers/admin-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { configureProvider, providerDetail, rejectCollisionProjection, runProviderOperation } from "../../lib/provider-management/service";
import { connectionSecretReference, ProviderManagementFailure } from "../../lib/provider-management/contracts";

describe("Providers Management v1 runtime RLS certification", () => {
  const org = randomUUID(), tenant = randomUUID(), otherTenant = randomUUID(), actor = randomUUID(), otherActor = randomUUID(), provider = randomUUID();
  const auth = { organizationId: org, tenantId: tenant, subjectId: actor };
  const foreign = { organizationId: org, tenantId: otherTenant, subjectId: otherActor };
  beforeAll(async () => {
    await adminPrisma.organization.create({ data: { id: org, name: "Provider management isolated certification" } });
    await adminPrisma.tenant.createMany({ data: [{ id: tenant, organizationId: org, name: "A" }, { id: otherTenant, organizationId: org, name: "B" }] });
    await adminPrisma.subject.createMany({ data: [{ id: actor, organizationId: org, tenantId: tenant, type: "HUMAN", name: "Actor A" },
      { id: otherActor, organizationId: org, tenantId: otherTenant, type: "HUMAN", name: "Actor B" }] });
    await adminPrisma.providerConnection.create({ data: { id: provider, organizationId: org, providerType: "MICROSOFT_ENTRA", externalScopeId: randomUUID(), name: "Certification" } });
    await adminPrisma.providerConnectionTenantScope.create({ data: { organizationId: org, tenantId: tenant, providerConnectionId: provider } });
  });
  afterAll(async () => {
    await adminPrisma.canonicalAdminAuditEvent.deleteMany({ where: { organizationId: org } });
    await adminPrisma.providerIdentityCollision.deleteMany({ where: { organizationId: org } });
    await adminPrisma.providerSyncRun.deleteMany({ where: { organizationId: org } });
    await adminPrisma.providerConnectionTenantScope.deleteMany({ where: { organizationId: org } });
    await adminPrisma.providerConnection.deleteMany({ where: { organizationId: org } });
    await adminPrisma.subject.deleteMany({ where: { organizationId: org } });
    await adminPrisma.tenant.deleteMany({ where: { organizationId: org } });
    await adminPrisma.organization.deleteMany({ where: { id: org } });
  });
  const healthy = () => ({ testConnection: async () => {}, async *discover() {
    yield { externalObjectId: "external-1", displayName: "Alice" };
    yield { externalObjectId: "external-1", displayName: "Duplicate" };
  } });
  it("certifies nonprivileged runtime posture and forced RLS", async () => {
    const posture = await withTenantDb(auth, tx => tx.$queryRaw<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(posture[0]).toMatchObject({ current_user: "app_user", rolsuper: false, rolbypassrls: false });
    const table = await adminPrisma.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"ProviderSyncRun"'::regclass`;
    expect(table[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
  it("rejects cross-tenant reads, configuration and network operations before reaching provider", async () => {
    await expect(providerDetail(foreign, provider, randomUUID())).rejects.toMatchObject({ httpStatus: 404 });
    await expect(configureProvider(foreign, provider, { expectedMappingVersion: 1, enabled: true }, randomUUID())).rejects.toMatchObject({ httpStatus: 404 });
    await expect(runProviderOperation(foreign, provider, "CONNECTION_TEST", randomUUID(), () => { throw new Error("must not execute"); })).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("binds secret references to org/tenant/connection and enforces optimistic configuration versions", async () => {
    await expect(configureProvider(auth, provider, { expectedMappingVersion: 1, credentialSecretRef: connectionSecretReference({ ...foreign, providerConnectionId: provider }) }, randomUUID()))
      .rejects.toMatchObject({ code: "PROVIDER_SECRET_SCOPE_MISMATCH" });
    await configureProvider(auth, provider, { expectedMappingVersion: 1, enabled: true,
      credentialSecretRef: connectionSecretReference({ ...auth, providerConnectionId: provider }) }, randomUUID());
    await expect(configureProvider(auth, provider, { expectedMappingVersion: 1, enabled: true }, randomUUID())).rejects.toMatchObject({ httpStatus: 409 });
  });
  it("executes a real orchestration dry-run, quarantines collisions, preserves canonical identities and audits", async () => {
    const operationId = randomUUID();
    const run = await runProviderOperation(auth, provider, "SYNC_DRY_RUN", operationId, healthy);
    expect(run).toMatchObject({ status: "CONFLICTED", observed: 2, conflicts: 1, created: 0, updated: 0, disabled: 0 });
    expect(await runProviderOperation(auth, provider, "SYNC_DRY_RUN", operationId, () => { throw new Error("replay must not execute"); })).toMatchObject({ id: run!.id });
    await expect(runProviderOperation(auth, provider, "CONNECTION_TEST", operationId, healthy)).rejects.toMatchObject({ code: "PROVIDER_OPERATION_ID_CONFLICT" });
    const detail = await providerDetail(auth, provider, randomUUID());
    expect(detail.provider.operationalStatus).toBe("DEGRADED"); expect(detail.collisions).toHaveLength(1);
    expect(detail.provider).not.toHaveProperty("credentialSecretRef");
    expect(detail.provider).not.toHaveProperty("configuration");
    expect(await adminPrisma.identityAccount.count({ where: { organizationId: org } })).toBe(0);
    expect(await adminPrisma.subject.count({ where: { organizationId: org } })).toBe(2);
    expect(await adminPrisma.canonicalAdminAuditEvent.count({ where: { organizationId: org, operation: "PROVIDER.SYNC_DRY_RUN.COMPLETE" } })).toBe(1);
    await expect(rejectCollisionProjection(foreign, provider, detail.collisions[0].id, randomUUID())).rejects.toMatchObject({ httpStatus: 404 });
    await rejectCollisionProjection(auth, provider, detail.collisions[0].id, randomUUID());
    expect(await adminPrisma.identityAccount.count({ where: { organizationId: org } })).toBe(0);
  });
  it("keeps raw runtime reads tenant isolated and prevents forged cross-tenant FK scope", async () => {
    expect(await withTenantDb(foreign, tx => tx.providerSyncRun.findMany({ where: { providerConnectionId: provider } }))).toEqual([]);
    await expect(withTenantDb(foreign, tx => tx.providerSyncRun.create({ data: { organizationId: org, tenantId: otherTenant,
      providerConnectionId: provider, operationId: randomUUID(), operation: "SYNC_DRY_RUN", mode: "DRY_RUN", status: "RUNNING" } }))).rejects.toThrow();
  });
  it("records safe errors and rejects disabled operations", async () => {
    const run = await runProviderOperation(auth, provider, "CONNECTION_TEST", randomUUID(), () => ({
      testConnection: async () => { throw new ProviderManagementFailure("PROVIDER_UNAVAILABLE"); }, async *discover() {},
    }));
    expect(run).toMatchObject({ status: "FAILED", safeErrorCode: "PROVIDER_UNAVAILABLE" });
    await configureProvider(auth, provider, { expectedMappingVersion: 2, enabled: false }, randomUUID());
    await expect(runProviderOperation(auth, provider, "CONNECTION_TEST", randomUUID(), healthy)).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
  });
});
