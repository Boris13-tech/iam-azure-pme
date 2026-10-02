-- CreateEnum
CREATE TYPE "AuthorizationShadowStatus" AS ENUM ('PARITY', 'DIVERGENCE', 'NATIVE_ERROR', 'LEGACY_ERROR');

-- CreateTable
CREATE TABLE "AuthorizationShadowObservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "legacyAllowed" BOOLEAN,
    "nativeAllowed" BOOLEAN,
    "nativeReasonCode" TEXT,
    "status" "AuthorizationShadowStatus" NOT NULL,
    "nativeAssignmentIds" JSONB,
    "nativeEntitlementIds" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthorizationShadowObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthorizationShadowObservation_organizationId_tenantId_createdAt_idx" ON "AuthorizationShadowObservation"("organizationId", "tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthorizationShadowObservation_status_createdAt_idx" ON "AuthorizationShadowObservation"("status", "createdAt");

-- Enable RLS
ALTER TABLE "AuthorizationShadowObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuthorizationShadowObservation" FORCE ROW LEVEL SECURITY;

-- Create RLS Policy
CREATE POLICY "tenant_isolation_policy" ON "AuthorizationShadowObservation"
  FOR ALL
  USING (
    "organizationId" = current_setting('app.current_organization_id', true)
    AND
    "tenantId" = current_setting('app.current_tenant_id', true)
  )
  WITH CHECK (
    "organizationId" = current_setting('app.current_organization_id', true)
    AND
    "tenantId" = current_setting('app.current_tenant_id', true)
  );
