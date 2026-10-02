-- Phase 6G is additive. Export payloads stay outside PostgreSQL and must be encrypted.
CREATE TYPE "IdentityPortabilityDirection" AS ENUM ('EXPORT', 'IMPORT');
CREATE TYPE "IdentityPortabilityStatus" AS ENUM ('STAGED', 'APPLIED', 'REJECTED');
CREATE TYPE "IdentityRecoveryCeremonyState" AS ENUM ('REQUESTED', 'APPROVED', 'VERIFIED', 'RESTORED_ISOLATED', 'ACTIVATED', 'FAILED');
CREATE TYPE "CredentialReenrollmentStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

ALTER TABLE "IdentityContinuityState" ADD COLUMN "recoveryEpoch" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "OfflineIdentityChallenge" ADD COLUMN "recoveryEpoch" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "IdentityAssuranceSnapshot" ADD COLUMN "recoveryEpoch" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "IdentityContinuityEvent" ADD COLUMN "recoveryEpoch" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "recoveryEpoch" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "IdentityContinuityState" ADD CONSTRAINT "IdentityContinuityState_recoveryEpoch_check" CHECK ("recoveryEpoch" >= 0);
ALTER TABLE "OfflineIdentityChallenge" ADD CONSTRAINT "OfflineIdentityChallenge_recoveryEpoch_check" CHECK ("recoveryEpoch" >= 0);
ALTER TABLE "IdentityAssuranceSnapshot" ADD CONSTRAINT "IdentityAssuranceSnapshot_recoveryEpoch_check" CHECK ("recoveryEpoch" >= 0);
ALTER TABLE "IdentityContinuityEvent" ADD CONSTRAINT "IdentityContinuityEvent_recoveryEpoch_check" CHECK ("recoveryEpoch" >= 0);
ALTER TABLE "Session" ADD CONSTRAINT "Session_recoveryEpoch_check" CHECK ("recoveryEpoch" >= 0);

CREATE TABLE "IdentityPortabilityReceipt" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "direction" "IdentityPortabilityDirection" NOT NULL,
  "manifestDigest" TEXT NOT NULL,
  "recoveryEpoch" BIGINT NOT NULL,
  "status" "IdentityPortabilityStatus" NOT NULL DEFAULT 'STAGED',
  "sourceDeploymentId" TEXT,
  "targetDeploymentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),
  CONSTRAINT "IdentityPortabilityReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IdentityPortabilityReceipt_epoch_check" CHECK ("recoveryEpoch" >= 0)
);

CREATE TABLE "IdentityRecoveryCeremony" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "manifestDigest" TEXT NOT NULL,
  "epochFrom" BIGINT NOT NULL,
  "epochTo" BIGINT NOT NULL,
  "state" "IdentityRecoveryCeremonyState" NOT NULL DEFAULT 'REQUESTED',
  "requiredApprovals" INTEGER NOT NULL,
  "isolatedEnvironment" BOOLEAN NOT NULL DEFAULT true,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  "restoredAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  CONSTRAINT "IdentityRecoveryCeremony_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IdentityRecoveryCeremony_security_check" CHECK ("epochFrom" >= 0 AND "epochTo" = "epochFrom" + 1 AND "requiredApprovals" >= 2 AND "isolatedEnvironment" = true)
);

CREATE TABLE "IdentityRecoveryApproval" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "ceremonyId" TEXT NOT NULL,
  "authorityId" TEXT NOT NULL,
  "evidenceDigest" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdentityRecoveryApproval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IdentityPortabilityConflict" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "existingDigest" TEXT NOT NULL,
  "incomingDigest" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "quarantinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "IdentityPortabilityConflict_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CredentialReenrollmentRequirement" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "originalCredentialId" TEXT NOT NULL,
  "recoveryEpoch" BIGINT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "status" "CredentialReenrollmentStatus" NOT NULL DEFAULT 'PENDING',
  "completedCredentialId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "CredentialReenrollmentRequirement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CredentialReenrollmentRequirement_epoch_check" CHECK ("recoveryEpoch" >= 0),
  CONSTRAINT "CredentialReenrollmentRequirement_completion_check" CHECK (
    ("status" = 'COMPLETED' AND "completedCredentialId" IS NOT NULL AND "completedAt" IS NOT NULL)
    OR ("status" <> 'COMPLETED' AND "completedCredentialId" IS NULL AND "completedAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "IdentityPortabilityReceipt_organizationId_tenantId_id_key" ON "IdentityPortabilityReceipt"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "IdentityPortabilityReceipt_organizationId_tenantId_packageId_direction_key" ON "IdentityPortabilityReceipt"("organizationId", "tenantId", "packageId", "direction");
CREATE INDEX "IdentityPortabilityReceipt_organizationId_tenantId_status_createdAt_idx" ON "IdentityPortabilityReceipt"("organizationId", "tenantId", "status", "createdAt");
CREATE UNIQUE INDEX "IdentityRecoveryCeremony_organizationId_tenantId_id_key" ON "IdentityRecoveryCeremony"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "IdentityRecoveryCeremony_organizationId_tenantId_packageId_key" ON "IdentityRecoveryCeremony"("organizationId", "tenantId", "packageId");
CREATE INDEX "IdentityRecoveryCeremony_organizationId_tenantId_state_requestedAt_idx" ON "IdentityRecoveryCeremony"("organizationId", "tenantId", "state", "requestedAt");
CREATE UNIQUE INDEX "IdentityRecoveryApproval_organizationId_tenantId_id_key" ON "IdentityRecoveryApproval"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "IdentityRecoveryApproval_organizationId_tenantId_ceremonyId_authorityId_key" ON "IdentityRecoveryApproval"("organizationId", "tenantId", "ceremonyId", "authorityId");
CREATE INDEX "IdentityRecoveryApproval_organizationId_tenantId_ceremonyId_idx" ON "IdentityRecoveryApproval"("organizationId", "tenantId", "ceremonyId");
CREATE UNIQUE INDEX "IdentityPortabilityConflict_organizationId_tenantId_id_key" ON "IdentityPortabilityConflict"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "IdentityPortabilityConflict_organizationId_tenantId_receiptId_entityType_entityId_key" ON "IdentityPortabilityConflict"("organizationId", "tenantId", "receiptId", "entityType", "entityId");
CREATE INDEX "IdentityPortabilityConflict_organizationId_tenantId_receiptId_idx" ON "IdentityPortabilityConflict"("organizationId", "tenantId", "receiptId");
CREATE UNIQUE INDEX "CredentialReenrollmentRequirement_organizationId_tenantId_id_key" ON "CredentialReenrollmentRequirement"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "CredentialReenrollmentRequirement_organizationId_tenantId_originalCredentialId_recoveryEpoch_key" ON "CredentialReenrollmentRequirement"("organizationId", "tenantId", "originalCredentialId", "recoveryEpoch");
CREATE INDEX "CredentialReenrollmentRequirement_organizationId_tenantId_subjectId_status_idx" ON "CredentialReenrollmentRequirement"("organizationId", "tenantId", "subjectId", "status");

ALTER TABLE "IdentityPortabilityReceipt" ADD CONSTRAINT "IdentityPortabilityReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityPortabilityReceipt" ADD CONSTRAINT "IdentityPortabilityReceipt_tenant_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityRecoveryCeremony" ADD CONSTRAINT "IdentityRecoveryCeremony_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityRecoveryCeremony" ADD CONSTRAINT "IdentityRecoveryCeremony_tenant_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityRecoveryApproval" ADD CONSTRAINT "IdentityRecoveryApproval_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityRecoveryApproval" ADD CONSTRAINT "IdentityRecoveryApproval_tenant_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityRecoveryApproval" ADD CONSTRAINT "IdentityRecoveryApproval_ceremony_fkey" FOREIGN KEY ("organizationId", "tenantId", "ceremonyId") REFERENCES "IdentityRecoveryCeremony"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityPortabilityConflict" ADD CONSTRAINT "IdentityPortabilityConflict_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityPortabilityConflict" ADD CONSTRAINT "IdentityPortabilityConflict_tenant_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityPortabilityConflict" ADD CONSTRAINT "IdentityPortabilityConflict_receipt_fkey" FOREIGN KEY ("organizationId", "tenantId", "receiptId") REFERENCES "IdentityPortabilityReceipt"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CredentialReenrollmentRequirement" ADD CONSTRAINT "CredentialReenrollmentRequirement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CredentialReenrollmentRequirement" ADD CONSTRAINT "CredentialReenrollmentRequirement_tenant_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CredentialReenrollmentRequirement" ADD CONSTRAINT "CredentialReenrollmentRequirement_subject_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IdentityPortabilityReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityPortabilityReceipt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "IdentityRecoveryCeremony" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityRecoveryCeremony" FORCE ROW LEVEL SECURITY;
ALTER TABLE "IdentityRecoveryApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityRecoveryApproval" FORCE ROW LEVEL SECURITY;
ALTER TABLE "IdentityPortabilityConflict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityPortabilityConflict" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CredentialReenrollmentRequirement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CredentialReenrollmentRequirement" FORCE ROW LEVEL SECURITY;

CREATE POLICY "identityportabilityreceipt_tenant_isolation" ON "IdentityPortabilityReceipt" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "identityrecoveryceremony_tenant_isolation" ON "IdentityRecoveryCeremony" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "identityrecoveryapproval_tenant_isolation" ON "IdentityRecoveryApproval" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "identityportabilityconflict_tenant_isolation" ON "IdentityPortabilityConflict" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "credentialreenrollmentrequirement_tenant_isolation" ON "CredentialReenrollmentRequirement" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
