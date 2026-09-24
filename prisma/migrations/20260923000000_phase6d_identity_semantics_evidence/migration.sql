-- Phase 6D first slice: additive universal lifecycle and authentication evidence.
CREATE TYPE "SubjectLifecycleState" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'DISABLED', 'RECOVERY_REQUIRED', 'RETIRED');
CREATE TYPE "AuthenticationMethod" AS ENUM ('PASSKEY', 'SECURITY_KEY', 'TOTP', 'SMART_CARD', 'MANAGED_DEVICE', 'FEDERATED_OIDC', 'DEVICE_KEY', 'WORKLOAD_KEY', 'SERVICE_KEY', 'AGENT_KEY', 'CUSTOM');
CREATE TYPE "AuthenticationAssuranceLevel" AS ENUM ('LOW', 'SUBSTANTIAL', 'HIGH');
CREATE TYPE "AuthenticationEvidenceOutcome" AS ENUM ('VERIFIED', 'REJECTED');
CREATE TYPE "AuthenticationEvidenceSource" AS ENUM ('LOCAL_VERIFIER', 'EXTERNAL_PROVIDER');
CREATE TYPE "AuthenticationUserVerification" AS ENUM ('VERIFIED', 'PROVIDER_ASSERTED', 'NOT_VERIFIED', 'NOT_APPLICABLE');

ALTER TABLE "Subject"
  ADD COLUMN "lifecycleState" "SubjectLifecycleState" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "lifecycleVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "lifecycleChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "Subject_lifecycleVersion_check" CHECK ("lifecycleVersion" > 0);

CREATE TABLE "AuthenticationEvidence" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "identityAccountId" TEXT,
  "providerConnectionId" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "method" "AuthenticationMethod" NOT NULL,
  "outcome" "AuthenticationEvidenceOutcome" NOT NULL,
  "assuranceLevel" "AuthenticationAssuranceLevel" NOT NULL,
  "assuranceProfile" TEXT NOT NULL,
  "assuranceProfileVersion" INTEGER NOT NULL,
  "phishingResistant" BOOLEAN NOT NULL,
  "hardwareBound" BOOLEAN NOT NULL,
  "userVerification" "AuthenticationUserVerification" NOT NULL,
  "source" "AuthenticationEvidenceSource" NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "verifierPolicyVersion" INTEGER NOT NULL,
  "operationId" TEXT NOT NULL,
  "correlationId" TEXT,
  "causationId" TEXT,
  "reasonCode" TEXT NOT NULL,
  "algorithmId" TEXT,
  "keyVersion" TEXT,
  "evidenceDigest" TEXT,
  "offline" BOOLEAN NOT NULL DEFAULT false,
  "partitionEpoch" BIGINT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthenticationEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuthenticationEvidence_versions_check" CHECK (
    "schemaVersion" > 0 AND "assuranceProfileVersion" > 0 AND "verifierPolicyVersion" > 0
  )
);

CREATE UNIQUE INDEX "AuthenticationEvidence_organizationId_tenantId_id_key" ON "AuthenticationEvidence"("organizationId", "tenantId", "id");
CREATE INDEX "AuthenticationEvidence_organizationId_tenantId_subjectId_occurredAt_idx" ON "AuthenticationEvidence"("organizationId", "tenantId", "subjectId", "occurredAt");
CREATE INDEX "AuthenticationEvidence_organizationId_tenantId_identityAccountId_occurredAt_idx" ON "AuthenticationEvidence"("organizationId", "tenantId", "identityAccountId", "occurredAt");
CREATE INDEX "AuthenticationEvidence_organizationId_tenantId_operationId_idx" ON "AuthenticationEvidence"("organizationId", "tenantId", "operationId");

ALTER TABLE "AuthenticationEvidence" ADD CONSTRAINT "AuthenticationEvidence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthenticationEvidence" ADD CONSTRAINT "AuthenticationEvidence_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthenticationEvidence" ADD CONSTRAINT "AuthenticationEvidence_subject_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthenticationEvidence" ADD CONSTRAINT "AuthenticationEvidence_identityAccount_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId", "identityAccountId") REFERENCES "IdentityAccount"("organizationId", "tenantId", "subjectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthenticationEvidence" ADD CONSTRAINT "AuthenticationEvidence_providerConnection_fkey" FOREIGN KEY ("organizationId", "providerConnectionId") REFERENCES "ProviderConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuthenticationEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuthenticationEvidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "authenticationevidence_tenant_isolation" ON "AuthenticationEvidence"
USING (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
)
WITH CHECK (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
);
