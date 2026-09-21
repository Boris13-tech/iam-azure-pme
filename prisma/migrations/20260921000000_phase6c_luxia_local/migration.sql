-- Phase 6C is additive: the existing provider and identity rows remain unchanged.
ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'LUXIA_LOCAL';

CREATE TYPE "LocalIdentityStatus" AS ENUM ('ACTIVE', 'DISABLED', 'LOCKED', 'RECOVERY_REQUIRED');
CREATE TYPE "LocalAuthenticatorType" AS ENUM ('PASSKEY', 'TOTP', 'SECURITY_KEY', 'SMART_CARD', 'MANAGED_DEVICE', 'CUSTOM');
CREATE TYPE "LocalAuthenticatorStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "LocalChallengePurpose" AS ENUM ('AUTHENTICATION', 'ENROLLMENT', 'RECOVERY');

CREATE UNIQUE INDEX "IdentityAccount_organizationId_tenantId_id_key"
  ON "IdentityAccount"("organizationId", "tenantId", "id");

CREATE TABLE "LocalIdentity" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "identityAccountId" TEXT NOT NULL,
  "principalName" TEXT NOT NULL,
  "status" "LocalIdentityStatus" NOT NULL DEFAULT 'ACTIVE',
  "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LocalIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LocalAuthenticator" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "identityAccountId" TEXT NOT NULL,
  "type" "LocalAuthenticatorType" NOT NULL,
  "status" "LocalAuthenticatorStatus" NOT NULL DEFAULT 'ACTIVE',
  "credentialId" TEXT,
  "publicKey" TEXT,
  "secretRef" TEXT,
  "secretVersion" TEXT,
  "relyingPartyId" TEXT,
  "allowedOrigin" TEXT,
  "signCount" BIGINT NOT NULL DEFAULT 0,
  "lastTotpStep" BIGINT,
  "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "LocalAuthenticator_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LocalAuthenticator_material_check" CHECK (
    ("type" IN ('PASSKEY', 'SECURITY_KEY') AND "credentialId" IS NOT NULL AND "publicKey" IS NOT NULL AND "secretRef" IS NULL)
    OR ("type" = 'TOTP' AND "secretRef" IS NOT NULL AND "publicKey" IS NULL)
    OR ("type" IN ('SMART_CARD', 'MANAGED_DEVICE', 'CUSTOM'))
  )
);

CREATE TABLE "LocalAuthChallenge" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "identityAccountId" TEXT NOT NULL,
  "authenticatorId" TEXT,
  "purpose" "LocalChallengePurpose" NOT NULL,
  "challengeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LocalAuthChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LocalAuthChallenge_attempts_check" CHECK ("attempts" >= 0 AND "maxAttempts" > 0)
);

CREATE TABLE "LocalRecoveryCode" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "identityAccountId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LocalRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LocalIdentity_organizationId_tenantId_id_key" ON "LocalIdentity"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "LocalIdentity_organizationId_tenantId_identityAccountId_key" ON "LocalIdentity"("organizationId", "tenantId", "identityAccountId");
CREATE UNIQUE INDEX "LocalIdentity_organizationId_tenantId_principalName_key" ON "LocalIdentity"("organizationId", "tenantId", "principalName");
CREATE INDEX "LocalIdentity_organizationId_tenantId_status_idx" ON "LocalIdentity"("organizationId", "tenantId", "status");
CREATE UNIQUE INDEX "LocalAuthenticator_organizationId_tenantId_id_key" ON "LocalAuthenticator"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "LocalAuthenticator_organizationId_tenantId_credentialId_key" ON "LocalAuthenticator"("organizationId", "tenantId", "credentialId");
CREATE INDEX "LocalAuthenticator_organizationId_tenantId_identityAccountId_status_idx" ON "LocalAuthenticator"("organizationId", "tenantId", "identityAccountId", "status");
CREATE UNIQUE INDEX "LocalAuthChallenge_organizationId_tenantId_id_key" ON "LocalAuthChallenge"("organizationId", "tenantId", "id");
CREATE INDEX "LocalAuthChallenge_organizationId_tenantId_identityAccountId_purpose_idx" ON "LocalAuthChallenge"("organizationId", "tenantId", "identityAccountId", "purpose");
CREATE INDEX "LocalAuthChallenge_expiresAt_idx" ON "LocalAuthChallenge"("expiresAt");
CREATE UNIQUE INDEX "LocalRecoveryCode_organizationId_tenantId_id_key" ON "LocalRecoveryCode"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "LocalRecoveryCode_organizationId_tenantId_codeHash_key" ON "LocalRecoveryCode"("organizationId", "tenantId", "codeHash");
CREATE INDEX "LocalRecoveryCode_organizationId_tenantId_identityAccountId_idx" ON "LocalRecoveryCode"("organizationId", "tenantId", "identityAccountId");

ALTER TABLE "LocalIdentity" ADD CONSTRAINT "LocalIdentity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalIdentity" ADD CONSTRAINT "LocalIdentity_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalIdentity" ADD CONSTRAINT "LocalIdentity_identityAccount_fkey" FOREIGN KEY ("organizationId", "tenantId", "identityAccountId") REFERENCES "IdentityAccount"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalAuthenticator" ADD CONSTRAINT "LocalAuthenticator_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalAuthenticator" ADD CONSTRAINT "LocalAuthenticator_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalAuthenticator" ADD CONSTRAINT "LocalAuthenticator_localIdentity_fkey" FOREIGN KEY ("organizationId", "tenantId", "identityAccountId") REFERENCES "LocalIdentity"("organizationId", "tenantId", "identityAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalAuthChallenge" ADD CONSTRAINT "LocalAuthChallenge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalAuthChallenge" ADD CONSTRAINT "LocalAuthChallenge_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalAuthChallenge" ADD CONSTRAINT "LocalAuthChallenge_localIdentity_fkey" FOREIGN KEY ("organizationId", "tenantId", "identityAccountId") REFERENCES "LocalIdentity"("organizationId", "tenantId", "identityAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalRecoveryCode" ADD CONSTRAINT "LocalRecoveryCode_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalRecoveryCode" ADD CONSTRAINT "LocalRecoveryCode_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocalRecoveryCode" ADD CONSTRAINT "LocalRecoveryCode_localIdentity_fkey" FOREIGN KEY ("organizationId", "tenantId", "identityAccountId") REFERENCES "LocalIdentity"("organizationId", "tenantId", "identityAccountId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every new table is protected by the same mandatory tenant boundary as the core.
ALTER TABLE "LocalIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LocalIdentity" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LocalAuthenticator" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LocalAuthenticator" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LocalAuthChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LocalAuthChallenge" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LocalRecoveryCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LocalRecoveryCode" FORCE ROW LEVEL SECURITY;

CREATE POLICY "localidentity_tenant_isolation" ON "LocalIdentity" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "localauthenticator_tenant_isolation" ON "LocalAuthenticator" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "localauthchallenge_tenant_isolation" ON "LocalAuthChallenge" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "localrecoverycode_tenant_isolation" ON "LocalRecoveryCode" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
