-- Additive operational management. Existing authentication configuration is unchanged.
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'OIDC_GENERIC';
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'SAML';
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'SCIM';
CREATE TYPE "ProviderOperationalStatus" AS ENUM ('CONNECTED', 'DEGRADED', 'ERROR', 'DISABLED');
CREATE TYPE "ProviderSyncRunStatus" AS ENUM ('RUNNING', 'DRY_RUN_COMPLETE', 'FAILED', 'CONFLICTED');
ALTER TABLE "ProviderConnectionTenantScope"
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "operationalStatus" "ProviderOperationalStatus" NOT NULL DEFAULT 'DISABLED',
  ADD COLUMN "configuration" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "credentialSecretRef" TEXT,
  ADD COLUMN "attributeMapping" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "mappingVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "lastHealthCheckAt" TIMESTAMP(3),
  ADD COLUMN "lastSyncAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "provider_mapping_version_positive" CHECK ("mappingVersion" > 0),
  ADD CONSTRAINT "provider_configuration_object" CHECK (jsonb_typeof("configuration") = 'object'),
  ADD CONSTRAINT "provider_mapping_object" CHECK (jsonb_typeof("attributeMapping") = 'object');
CREATE TABLE "ProviderSyncRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerConnectionId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "operation" TEXT NOT NULL CHECK ("operation" IN ('CONNECTION_TEST', 'SYNC_DRY_RUN')),
  "mode" TEXT NOT NULL,
  "status" "ProviderSyncRunStatus" NOT NULL,
  "observed" INTEGER NOT NULL DEFAULT 0,
  "created" INTEGER NOT NULL DEFAULT 0,
  "updated" INTEGER NOT NULL DEFAULT 0,
  "disabled" INTEGER NOT NULL DEFAULT 0,
  "conflicts" INTEGER NOT NULL DEFAULT 0,
  "cursor" JSONB,
  "safeErrorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "provider_sync_dry_run_only" CHECK ("mode" = 'DRY_RUN' AND "created" = 0 AND "updated" = 0 AND "disabled" = 0),
  CONSTRAINT "provider_sync_counts" CHECK ("observed" >= 0 AND "conflicts" >= 0),
  CONSTRAINT "ProviderSyncRun_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProviderSyncRun_tenant_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProviderSyncRun_provider_fkey" FOREIGN KEY ("organizationId", "providerConnectionId") REFERENCES "ProviderConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProviderSyncRun_scope_fkey" FOREIGN KEY ("organizationId", "tenantId", "providerConnectionId") REFERENCES "ProviderConnectionTenantScope"("organizationId", "tenantId", "providerConnectionId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProviderSyncRun_organizationId_tenantId_id_key" ON "ProviderSyncRun"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "ProviderSyncRun_organizationId_tenantId_providerConnectionId_o_key" ON "ProviderSyncRun"("organizationId", "tenantId", "providerConnectionId", "operationId");
CREATE INDEX "ProviderSyncRun_organizationId_tenantId_providerConnectionId_s_idx" ON "ProviderSyncRun"("organizationId", "tenantId", "providerConnectionId", "startedAt");
CREATE INDEX "ProviderSyncRun_organizationId_tenantId_status_startedAt_idx" ON "ProviderSyncRun"("organizationId", "tenantId", "status", "startedAt");
CREATE INDEX "ProviderSyncRun_organizationId_providerConnectionId_idx" ON "ProviderSyncRun"("organizationId", "providerConnectionId");
ALTER TABLE "ProviderSyncRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderSyncRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_sync_tenant_isolation" ON "ProviderSyncRun"
USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true))
WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON "ProviderSyncRun" TO app_user;
    GRANT SELECT, INSERT, UPDATE ON "ProviderIdentityCollision" TO app_user;
  END IF;
END $$;
