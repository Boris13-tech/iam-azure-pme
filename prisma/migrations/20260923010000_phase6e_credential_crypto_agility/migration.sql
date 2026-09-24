-- Phase 6E is additive. Existing credentials remain valid under explicit legacy metadata.
ALTER TYPE "LocalAuthenticatorStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "LocalAuthenticatorStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED';
ALTER TYPE "LocalAuthenticatorStatus" ADD VALUE IF NOT EXISTS 'COMPROMISED';
ALTER TYPE "LocalAuthenticatorStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "LocalAuthenticatorStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';

CREATE TYPE "CryptoKeyPurpose" AS ENUM ('CREDENTIAL_VERIFICATION', 'EVIDENCE_SIGNING', 'SECRET_ENCRYPTION', 'RECOVERY', 'SYNCHRONIZATION', 'UPDATE_VERIFICATION');
CREATE TYPE "CryptoKeyStatus" AS ENUM ('PENDING', 'ACTIVE', 'VERIFY_ONLY', 'REVOKED', 'COMPROMISED', 'RETIRED');
CREATE TYPE "TrustAnchorStatus" AS ENUM ('PENDING', 'ACTIVE', 'VERIFY_ONLY', 'REVOKED', 'COMPROMISED', 'RETIRED');

ALTER TABLE "LocalAuthenticator"
  ADD COLUMN "credentialSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "credentialFormat" TEXT NOT NULL DEFAULT 'LUXIA_LOCAL_LEGACY',
  ADD COLUMN "credentialFormatVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "algorithmId" TEXT NOT NULL DEFAULT 'LEGACY_UNSPECIFIED',
  ADD COLUMN "algorithmVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "keyId" TEXT,
  ADD COLUMN "keyVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "trustAnchorId" TEXT,
  ADD COLUMN "trustAnchorVersion" INTEGER,
  ADD COLUMN "verifierPolicyVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "hardwareBound" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deviceSubjectId" TEXT,
  ADD COLUMN "userVerificationRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "migratedFromAuthenticatorId" TEXT,
  ADD COLUMN "supersededByAuthenticatorId" TEXT,
  ADD COLUMN "compromisedAt" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "LocalAuthenticator_crypto_versions_check" CHECK (
    "credentialSchemaVersion" > 0 AND "credentialFormatVersion" > 0
    AND "algorithmVersion" > 0 AND "keyVersion" > 0 AND "verifierPolicyVersion" > 0
    AND ("trustAnchorVersion" IS NULL OR "trustAnchorVersion" > 0)
  );

UPDATE "LocalAuthenticator"
SET "credentialFormat" = 'WEBAUTHN_PUBLIC_KEY', "algorithmId" = 'WEBAUTHN_ES256'
WHERE "type" IN ('PASSKEY', 'SECURITY_KEY');

UPDATE "LocalAuthenticator"
SET "credentialFormat" = 'RFC6238_TOTP', "algorithmId" = 'TOTP_HMAC_SHA1'
WHERE "type" = 'TOTP';

CREATE INDEX "LocalAuthenticator_organizationId_tenantId_deviceSubjectId_idx" ON "LocalAuthenticator"("organizationId", "tenantId", "deviceSubjectId");
ALTER TABLE "LocalAuthenticator" ADD CONSTRAINT "LocalAuthenticator_deviceSubject_fkey" FOREIGN KEY ("organizationId", "tenantId", "deviceSubjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuthenticationEvidence"
  ADD COLUMN "cryptoSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "algorithmVersion" INTEGER,
  ADD COLUMN "keyId" TEXT,
  ADD COLUMN "trustAnchorId" TEXT,
  ADD COLUMN "trustAnchorVersion" INTEGER,
  ADD CONSTRAINT "AuthenticationEvidence_crypto_versions_check" CHECK (
    "cryptoSchemaVersion" > 0
    AND ("algorithmVersion" IS NULL OR "algorithmVersion" > 0)
    AND ("trustAnchorVersion" IS NULL OR "trustAnchorVersion" > 0)
  );

CREATE TABLE "CryptoKeyVersion" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "logicalKeyId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "purpose" "CryptoKeyPurpose" NOT NULL,
  "algorithmId" TEXT NOT NULL,
  "algorithmVersion" INTEGER NOT NULL,
  "status" "CryptoKeyStatus" NOT NULL DEFAULT 'PENDING',
  "publicMaterial" TEXT,
  "custodyRef" TEXT,
  "custodyVersion" TEXT,
  "activatedAt" TIMESTAMP(3),
  "verifyUntil" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "compromisedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CryptoKeyVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CryptoKeyVersion_versions_check" CHECK ("version" > 0 AND "algorithmVersion" > 0),
  CONSTRAINT "CryptoKeyVersion_material_check" CHECK ("publicMaterial" IS NOT NULL OR "custodyRef" IS NOT NULL)
);

CREATE TABLE "TrustAnchorVersion" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "trustAnchorId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "algorithmId" TEXT NOT NULL,
  "algorithmVersion" INTEGER NOT NULL,
  "status" "TrustAnchorStatus" NOT NULL DEFAULT 'PENDING',
  "publicMaterial" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "validFrom" TIMESTAMP(3) NOT NULL,
  "validUntil" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "compromisedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrustAnchorVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrustAnchorVersion_versions_check" CHECK ("version" > 0 AND "algorithmVersion" > 0)
);

CREATE UNIQUE INDEX "CryptoKeyVersion_organizationId_tenantId_id_key" ON "CryptoKeyVersion"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "CryptoKeyVersion_organizationId_tenantId_logicalKeyId_version_key" ON "CryptoKeyVersion"("organizationId", "tenantId", "logicalKeyId", "version");
CREATE INDEX "CryptoKeyVersion_organizationId_tenantId_purpose_status_idx" ON "CryptoKeyVersion"("organizationId", "tenantId", "purpose", "status");
CREATE UNIQUE INDEX "TrustAnchorVersion_organizationId_tenantId_id_key" ON "TrustAnchorVersion"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "TrustAnchorVersion_organizationId_tenantId_trustAnchorId_version_key" ON "TrustAnchorVersion"("organizationId", "tenantId", "trustAnchorId", "version");
CREATE UNIQUE INDEX "TrustAnchorVersion_organizationId_tenantId_fingerprint_key" ON "TrustAnchorVersion"("organizationId", "tenantId", "fingerprint");
CREATE INDEX "TrustAnchorVersion_organizationId_tenantId_status_idx" ON "TrustAnchorVersion"("organizationId", "tenantId", "status");

ALTER TABLE "CryptoKeyVersion" ADD CONSTRAINT "CryptoKeyVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CryptoKeyVersion" ADD CONSTRAINT "CryptoKeyVersion_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustAnchorVersion" ADD CONSTRAINT "TrustAnchorVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustAnchorVersion" ADD CONSTRAINT "TrustAnchorVersion_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CryptoKeyVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CryptoKeyVersion" FORCE ROW LEVEL SECURITY;
ALTER TABLE "TrustAnchorVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrustAnchorVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "cryptokeyversion_tenant_isolation" ON "CryptoKeyVersion" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "trustanchorversion_tenant_isolation" ON "TrustAnchorVersion" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
