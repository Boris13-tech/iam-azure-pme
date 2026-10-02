-- Phase 6H adds provider discriminators only. Directory data remains a provider projection.
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'LDAP';
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'ACTIVE_DIRECTORY';
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'SAMBA_AD';

CREATE TABLE "ProviderIdentityCollision" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerConnectionId" TEXT NOT NULL,
  "externalObjectId" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "quarantinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "ProviderIdentityCollision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProviderIdentityCollision_organizationId_tenantId_id_key" ON "ProviderIdentityCollision"("organizationId", "tenantId", "id");
CREATE INDEX "ProviderIdentityCollision_scope_external_idx" ON "ProviderIdentityCollision"("organizationId", "tenantId", "providerConnectionId", "externalObjectId");
CREATE INDEX "ProviderIdentityCollision_scope_resolution_idx" ON "ProviderIdentityCollision"("organizationId", "tenantId", "resolvedAt", "quarantinedAt");
ALTER TABLE "ProviderIdentityCollision" ADD CONSTRAINT "ProviderIdentityCollision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderIdentityCollision" ADD CONSTRAINT "ProviderIdentityCollision_tenant_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderIdentityCollision" ADD CONSTRAINT "ProviderIdentityCollision_provider_fkey" FOREIGN KEY ("organizationId", "providerConnectionId") REFERENCES "ProviderConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderIdentityCollision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderIdentityCollision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provideridentitycollision_tenant_isolation" ON "ProviderIdentityCollision"
USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true))
WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
