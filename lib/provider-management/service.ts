import { Prisma } from "@prisma/client";
import type { AuthContext } from "../auth/authorization-engine";
import { withTenantDb } from "../db/scoped-client";
import { CanonicalAdminError } from "../admin/canonical-administration";
import { connectionSecretReference, managedProviderTypes, ProviderManagementFailure, reconcileDryRun, providerManagementUpdateSchema,
  type ProviderManagementUpdate, type ProviderManagementDriver, type ProviderOperation, type DiscoveryProjection } from "./contracts";

const scopeKey = (auth: AuthContext, providerConnectionId: string) => ({
  organizationId: auth.organizationId, tenantId: auth.tenantId, providerConnectionId,
});

// Deliberate response allowlist: credential references and raw config never leave the service.
export function publicProvider(scope: {
  providerConnectionId: string; displayName: string | null; enabled: boolean;
  operationalStatus: string; mappingVersion: number; attributeMapping: Prisma.JsonValue;
  credentialSecretRef: string | null; lastHealthCheckAt: Date | null; lastSyncAt: Date | null;
  lastErrorCode: string | null;
  providerConnection: { name: string; providerType: string; externalScopeId: string };
}) {
  return {
    id: scope.providerConnectionId, name: scope.displayName ?? scope.providerConnection.name,
    providerType: scope.providerConnection.providerType, externalScopeId: scope.providerConnection.externalScopeId,
    enabled: scope.enabled, operationalStatus: scope.operationalStatus,
    mappingVersion: scope.mappingVersion, attributeMapping: scope.attributeMapping,
    configured: scope.credentialSecretRef != null,
    lastHealthCheckAt: scope.lastHealthCheckAt, lastSyncAt: scope.lastSyncAt, lastErrorCode: scope.lastErrorCode,
  };
}

async function audit(tx: Prisma.TransactionClient, auth: AuthContext, providerConnectionId: string,
  operation: string, changeId: string) {
  return tx.canonicalAdminAuditEvent.create({ data: {
    organizationId: auth.organizationId, tenantId: auth.tenantId, actorSubjectId: auth.subjectId,
    operation, changeId, result: "SUCCESS", metadata: { providerConnectionId },
  } });
}

export async function listManagedProviders(auth: AuthContext, changeId: string) {
  return withTenantDb(auth, async tx => {
    const rows = await tx.providerConnectionTenantScope.findMany({
      where: { organizationId: auth.organizationId, tenantId: auth.tenantId },
      include: { providerConnection: true }, orderBy: { createdAt: "desc" }, take: 100,
    });
    await audit(tx, auth, "list", "PROVIDER.MANAGEMENT.READ", changeId);
    return rows.map(publicProvider);
  });
}

export async function providerDetail(auth: AuthContext, id: string, changeId: string) {
  return withTenantDb(auth, async tx => {
    const scope = await tx.providerConnectionTenantScope.findUnique({
      where: { organizationId_tenantId_providerConnectionId: scopeKey(auth, id) }, include: { providerConnection: true },
    });
    if (!scope) throw new CanonicalAdminError("PROVIDER_NOT_IN_TENANT_SCOPE", 404);
    const [history, collisions] = await Promise.all([
      tx.providerSyncRun.findMany({ where: scopeKey(auth, id), orderBy: { startedAt: "desc" }, take: 50 }),
      tx.providerIdentityCollision.findMany({ where: scopeKey(auth, id), orderBy: { quarantinedAt: "desc" }, take: 50,
        select: { id: true, externalObjectId: true, reasonCode: true, quarantinedAt: true, resolvedAt: true } }),
    ]);
    await audit(tx, auth, id, "PROVIDER.MANAGEMENT.READ", changeId);
    return { provider: publicProvider(scope), history, collisions,
      expectedSecretReference: connectionSecretReference(scopeKey(auth, id)) };
  });
}

export async function configureProvider(auth: AuthContext, id: string, raw: ProviderManagementUpdate, changeId: string) {
  const input = providerManagementUpdateSchema.parse(raw);
  if (input.credentialSecretRef && input.credentialSecretRef !== connectionSecretReference(scopeKey(auth, id))) {
    throw new CanonicalAdminError("PROVIDER_SECRET_SCOPE_MISMATCH", 400);
  }
  return withTenantDb(auth, async tx => {
    const key = scopeKey(auth, id);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(key)}, 0))`;
    const existing = await tx.providerConnectionTenantScope.findUnique({
      where: { organizationId_tenantId_providerConnectionId: key }, include: { providerConnection: true },
    });
    if (!existing) throw new CanonicalAdminError("PROVIDER_NOT_IN_TENANT_SCOPE", 404);
    const busy = await tx.providerSyncRun.findFirst({ where: { ...key, status: "RUNNING" } });
    if (busy) throw new CanonicalAdminError("PROVIDER_OPERATION_IN_PROGRESS", 409);
    const changed = await tx.providerConnectionTenantScope.updateMany({
      where: { ...key, mappingVersion: input.expectedMappingVersion },
      data: {
        ...(input.configuration ? { configuration: input.configuration } : {}),
        ...(input.credentialSecretRef !== undefined ? { credentialSecretRef: input.credentialSecretRef } : {}),
        ...(input.attributeMapping ? { attributeMapping: input.attributeMapping } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        mappingVersion: { increment: 1 },
        // Configuration changes invalidate the last connection proof.
        operationalStatus: input.enabled === false || (!existing.enabled && input.enabled !== true) ? "DISABLED" : "DEGRADED",
        lastHealthCheckAt: null, lastErrorCode: null,
      },
    });
    if (changed.count !== 1) throw new CanonicalAdminError("PROVIDER_CONFIGURATION_VERSION_CONFLICT", 409);
    await audit(tx, auth, id, "PROVIDER.CONFIGURE", changeId);
    return { id, mappingVersion: input.expectedMappingVersion + 1 };
  });
}

export async function rejectCollisionProjection(auth: AuthContext, id: string, collisionId: string, changeId: string) {
  return withTenantDb(auth, async tx => {
    const key = scopeKey(auth, id);
    if (!await tx.providerConnectionTenantScope.findUnique({ where: { organizationId_tenantId_providerConnectionId: key } })) {
      throw new CanonicalAdminError("PROVIDER_NOT_IN_TENANT_SCOPE", 404);
    }
    const collision = await tx.providerIdentityCollision.findFirst({ where: { ...key, id: collisionId, resolvedAt: null } });
    if (!collision) throw new CanonicalAdminError("OPEN_COLLISION_NOT_FOUND", 404);
    const updated = await tx.providerIdentityCollision.updateMany({ where: { ...key, id: collisionId, resolvedAt: null },
      data: { resolvedAt: new Date() } });
    if (updated.count !== 1) throw new CanonicalAdminError("COLLISION_RESOLUTION_CONFLICT", 409);
    await tx.canonicalAdminAuditEvent.create({ data: {
      organizationId: auth.organizationId, tenantId: auth.tenantId, actorSubjectId: auth.subjectId,
      operation: "PROVIDER.COLLISION.REJECT_PROJECTION", changeId, result: "SUCCESS",
      metadata: { providerConnectionId: id, collisionId, disposition: "REJECT_PROJECTION" },
    } });
    return { id: collisionId, disposition: "REJECT_PROJECTION" };
  });
}

export async function runProviderOperation(auth: AuthContext, id: string, operation: ProviderOperation,
  changeId: string, driverFactory: (input: {
    context: { organizationId: string; tenantId: string; providerConnectionId: string; operationId: string };
    type: string; externalScopeId: string; configuration: unknown; attributeMapping: unknown; credentialSecretRef: string | null;
  }) => ProviderManagementDriver) {
  if (!changeId.trim() || changeId.length > 128) throw new CanonicalAdminError("INVALID_CHANGE_ID", 400);
  const key = scopeKey(auth, id);
  const setup = await withTenantDb(auth, async tx => {
    // Serialize operation/configuration changes for this tenant connection.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(key)}, 0))`;
    const scope = await tx.providerConnectionTenantScope.findUnique({
      where: { organizationId_tenantId_providerConnectionId: key }, include: { providerConnection: true },
    });
    if (!scope) throw new CanonicalAdminError("PROVIDER_NOT_IN_TENANT_SCOPE", 404);
    const prior = await tx.providerSyncRun.findUnique({
      where: { organizationId_tenantId_providerConnectionId_operationId: { ...key, operationId: changeId } },
    });
    if (prior) {
      if (prior.operation !== operation) throw new CanonicalAdminError("PROVIDER_OPERATION_ID_CONFLICT", 409);
      return { replay: prior };
    }
    if (!scope.enabled) throw new CanonicalAdminError("PROVIDER_DISABLED", 409);
    if (!(managedProviderTypes as readonly string[]).includes(scope.providerConnection.providerType)) {
      throw new CanonicalAdminError("PROVIDER_OPERATION_UNSUPPORTED", 422);
    }
    if (operation === "SYNC_DRY_RUN" && scope.providerConnection.providerType === "OIDC_GENERIC") {
      throw new CanonicalAdminError("DIRECTORY_DISCOVERY_UNSUPPORTED", 422);
    }
    if (await tx.providerSyncRun.findFirst({ where: { ...key, status: "RUNNING" } })) {
      throw new CanonicalAdminError("PROVIDER_OPERATION_IN_PROGRESS", 409);
    }
    const run = await tx.providerSyncRun.create({ data: {
      ...key, operationId: changeId, operation, mode: "DRY_RUN", status: "RUNNING",
    } });
    await audit(tx, auth, id, `PROVIDER.${operation}.START`, changeId);
    return { scope, run };
  });
  if ("replay" in setup) return setup.replay;
  const projections: DiscoveryProjection[] = [];
  let failure: string | undefined;
  try {
    const driver = driverFactory({ context: { ...key, operationId: changeId },
      type: setup.scope.providerConnection.providerType, externalScopeId: setup.scope.providerConnection.externalScopeId,
      configuration: setup.scope.configuration, attributeMapping: setup.scope.attributeMapping,
      credentialSecretRef: setup.scope.credentialSecretRef });
    if (operation === "CONNECTION_TEST") await driver.testConnection();
    else for await (const projection of driver.discover()) {
      if (projections.length >= 1000) throw new ProviderManagementFailure("DISCOVERY_LIMIT_EXCEEDED");
      projections.push(projection);
    }
  } catch (error) {
    failure = error instanceof ProviderManagementFailure ? error.safeCode : "PROVIDER_OPERATION_FAILED";
  }
  return withTenantDb(auth, async tx => {
    const links = failure ? [] : await tx.identityAccount.findMany({ where: key, select: { externalObjectId: true } });
    const result = reconcileDryRun(projections, new Set(links.map(link => link.externalObjectId)));
    // An incomplete result never creates account links or Subjects.
    for (const externalObjectId of result.collisions) {
      await tx.providerIdentityCollision.create({ data: { ...key, externalObjectId,
        reasonCode: "DUPLICATE_EXTERNAL_ID", evidence: { operationId: changeId, mappingVersion: setup.scope.mappingVersion } } });
    }
    const run = await tx.providerSyncRun.update({
      where: { organizationId_tenantId_id: { organizationId: auth.organizationId, tenantId: auth.tenantId, id: setup.run.id } },
      data: { status: failure ? "FAILED" : result.collisions.length ? "CONFLICTED" : "DRY_RUN_COMPLETE",
        observed: result.observed, conflicts: result.collisions.length, safeErrorCode: failure ?? null, completedAt: new Date() },
    });
    await tx.providerConnectionTenantScope.update({
      where: { organizationId_tenantId_providerConnectionId: key },
      data: { operationalStatus: failure ? "ERROR" : result.collisions.length ? "DEGRADED" : "CONNECTED",
        lastErrorCode: failure ?? null,
        ...(operation === "CONNECTION_TEST" ? { lastHealthCheckAt: new Date() } : { lastSyncAt: new Date() }) },
    });
    await tx.canonicalAdminAuditEvent.create({ data: {
      organizationId: auth.organizationId, tenantId: auth.tenantId, actorSubjectId: auth.subjectId,
      operation: `PROVIDER.${operation}.COMPLETE`, changeId: `complete:${setup.run.id}`,
      result: failure ? "FAILURE" : "SUCCESS", metadata: { providerConnectionId: id,
        observed: result.observed, conflicts: result.collisions.length, errorCode: failure ?? null },
    } });
    return run;
  });
}
