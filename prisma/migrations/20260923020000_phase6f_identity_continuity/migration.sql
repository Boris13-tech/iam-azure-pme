-- Phase 6F is additive. Continuity artifacts are tenant-scoped evidence, never bearer tokens.
CREATE TYPE "IdentityContinuityMode" AS ENUM ('CONNECTED', 'DEGRADED', 'PARTITIONED', 'OFFLINE', 'RECOVERING');
CREATE TYPE "IdentityContinuityEventType" AS ENUM ('MODE_TRANSITION', 'OFFLINE_CHALLENGE_ISSUED', 'OFFLINE_PROOF_VERIFIED', 'SNAPSHOT_ISSUED', 'SNAPSHOT_REJECTED', 'RECONCILIATION_STARTED', 'RECONCILIATION_APPLIED', 'RECONCILIATION_CONFLICT', 'RECONCILIATION_COMPLETED');
CREATE TYPE "IdentityContinuityConflictStatus" AS ENUM ('QUARANTINED', 'RESOLVED_KEEP_LOCAL', 'RESOLVED_APPLY_RESTRICTIVE', 'RESOLVED_REVIEWED');

ALTER TABLE "LocalAuthenticator"
  ADD COLUMN "stateVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "LocalAuthenticator_stateVersion_check" CHECK ("stateVersion" > 0);

CREATE TABLE "IdentityContinuityState" (
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "mode" "IdentityContinuityMode" NOT NULL DEFAULT 'CONNECTED',
  "partitionEpoch" BIGINT NOT NULL DEFAULT 0,
  "sequence" BIGINT NOT NULL DEFAULT 0,
  "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastConnectedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdentityContinuityState_pkey" PRIMARY KEY ("organizationId", "tenantId"),
  CONSTRAINT "IdentityContinuityState_versions_check" CHECK ("partitionEpoch" >= 0 AND "sequence" >= 0)
);

CREATE TABLE "OfflineIdentityChallenge" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "verifierId" TEXT NOT NULL,
  "audience" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "nonceDigest" TEXT NOT NULL,
  "partitionEpoch" BIGINT NOT NULL,
  "continuityMode" "IdentityContinuityMode" NOT NULL,
  "algorithmId" TEXT NOT NULL,
  "algorithmVersion" INTEGER NOT NULL,
  "issuerKeyId" TEXT NOT NULL,
  "issuerKeyVersion" INTEGER NOT NULL,
  "challengeSignature" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OfflineIdentityChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OfflineIdentityChallenge_freshness_check" CHECK (
    "partitionEpoch" >= 0 AND "algorithmVersion" > 0 AND "issuerKeyVersion" > 0
    AND "expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + INTERVAL '5 minutes'
    AND ("consumedAt" IS NULL OR ("consumedAt" >= "issuedAt" AND "consumedAt" < "expiresAt"))
  )
);

CREATE TABLE "IdentityAssuranceSnapshot" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "issuer" TEXT NOT NULL,
  "audience" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "scopeDigest" TEXT NOT NULL,
  "evidenceDigest" TEXT NOT NULL,
  "assuranceProfile" TEXT NOT NULL,
  "assuranceLevel" "AuthenticationAssuranceLevel" NOT NULL,
  "partitionEpoch" BIGINT NOT NULL,
  "sequence" BIGINT NOT NULL,
  "lifecycleVersion" BIGINT NOT NULL,
  "credentialStateVersion" BIGINT NOT NULL,
  "algorithmId" TEXT NOT NULL,
  "algorithmVersion" INTEGER NOT NULL,
  "issuerKeyId" TEXT NOT NULL,
  "issuerKeyVersion" INTEGER NOT NULL,
  "signature" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdentityAssuranceSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IdentityAssuranceSnapshot_versions_check" CHECK (
    "schemaVersion" > 0 AND "partitionEpoch" >= 0 AND "sequence" >= 0
    AND "lifecycleVersion" >= 0 AND "credentialStateVersion" >= 0
    AND "algorithmVersion" > 0 AND "issuerKeyVersion" > 0
    AND "expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + INTERVAL '8 hours'
    AND ("revokedAt" IS NULL OR "revokedAt" >= "issuedAt")
  )
);

CREATE TABLE "IdentityContinuityEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "subjectId" TEXT,
  "eventType" "IdentityContinuityEventType" NOT NULL,
  "mode" "IdentityContinuityMode" NOT NULL,
  "partitionEpoch" BIGINT NOT NULL,
  "sequence" BIGINT NOT NULL,
  "operationId" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "evidenceDigest" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdentityContinuityEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IdentityContinuityEvent_order_check" CHECK ("partitionEpoch" >= 0 AND "sequence" >= 0)
);

CREATE TABLE "IdentityContinuityConflict" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "subjectId" TEXT,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "localVersion" BIGINT NOT NULL,
  "remoteVersion" BIGINT NOT NULL,
  "localDigest" TEXT NOT NULL,
  "remoteDigest" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "status" "IdentityContinuityConflictStatus" NOT NULL DEFAULT 'QUARANTINED',
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "IdentityContinuityConflict_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IdentityContinuityConflict_versions_check" CHECK ("localVersion" >= 0 AND "remoteVersion" >= 0)
);

CREATE INDEX "IdentityContinuityState_organizationId_tenantId_mode_idx" ON "IdentityContinuityState"("organizationId", "tenantId", "mode");
CREATE UNIQUE INDEX "OfflineIdentityChallenge_organizationId_tenantId_id_key" ON "OfflineIdentityChallenge"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "OfflineIdentityChallenge_organizationId_tenantId_nonceDigest_key" ON "OfflineIdentityChallenge"("organizationId", "tenantId", "nonceDigest");
CREATE INDEX "OfflineIdentityChallenge_organizationId_tenantId_subjectId_expiresAt_idx" ON "OfflineIdentityChallenge"("organizationId", "tenantId", "subjectId", "expiresAt");
CREATE INDEX "OfflineIdentityChallenge_organizationId_tenantId_consumedAt_idx" ON "OfflineIdentityChallenge"("organizationId", "tenantId", "consumedAt");
CREATE UNIQUE INDEX "IdentityAssuranceSnapshot_organizationId_tenantId_id_key" ON "IdentityAssuranceSnapshot"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "IdentityAssuranceSnapshot_organizationId_tenantId_subjectId_partitionEpoch_sequence_key" ON "IdentityAssuranceSnapshot"("organizationId", "tenantId", "subjectId", "partitionEpoch", "sequence");
CREATE INDEX "IdentityAssuranceSnapshot_organizationId_tenantId_subjectId_expiresAt_idx" ON "IdentityAssuranceSnapshot"("organizationId", "tenantId", "subjectId", "expiresAt");
CREATE UNIQUE INDEX "IdentityContinuityEvent_organizationId_tenantId_id_key" ON "IdentityContinuityEvent"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "IdentityContinuityEvent_organizationId_tenantId_partitionEpoch_sequence_key" ON "IdentityContinuityEvent"("organizationId", "tenantId", "partitionEpoch", "sequence");
CREATE INDEX "IdentityContinuityEvent_organizationId_tenantId_subjectId_occurredAt_idx" ON "IdentityContinuityEvent"("organizationId", "tenantId", "subjectId", "occurredAt");
CREATE UNIQUE INDEX "IdentityContinuityConflict_organizationId_tenantId_id_key" ON "IdentityContinuityConflict"("organizationId", "tenantId", "id");
CREATE INDEX "IdentityContinuityConflict_organizationId_tenantId_status_detectedAt_idx" ON "IdentityContinuityConflict"("organizationId", "tenantId", "status", "detectedAt");
CREATE INDEX "IdentityContinuityConflict_organizationId_tenantId_entityType_entityId_idx" ON "IdentityContinuityConflict"("organizationId", "tenantId", "entityType", "entityId");

ALTER TABLE "IdentityContinuityState" ADD CONSTRAINT "IdentityContinuityState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityContinuityState" ADD CONSTRAINT "IdentityContinuityState_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflineIdentityChallenge" ADD CONSTRAINT "OfflineIdentityChallenge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflineIdentityChallenge" ADD CONSTRAINT "OfflineIdentityChallenge_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflineIdentityChallenge" ADD CONSTRAINT "OfflineIdentityChallenge_subject_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityAssuranceSnapshot" ADD CONSTRAINT "IdentityAssuranceSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityAssuranceSnapshot" ADD CONSTRAINT "IdentityAssuranceSnapshot_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityAssuranceSnapshot" ADD CONSTRAINT "IdentityAssuranceSnapshot_subject_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityContinuityEvent" ADD CONSTRAINT "IdentityContinuityEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityContinuityEvent" ADD CONSTRAINT "IdentityContinuityEvent_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityContinuityEvent" ADD CONSTRAINT "IdentityContinuityEvent_subject_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityContinuityConflict" ADD CONSTRAINT "IdentityContinuityConflict_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityContinuityConflict" ADD CONSTRAINT "IdentityContinuityConflict_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdentityContinuityConflict" ADD CONSTRAINT "IdentityContinuityConflict_subject_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IdentityContinuityState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityContinuityState" FORCE ROW LEVEL SECURITY;
ALTER TABLE "OfflineIdentityChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OfflineIdentityChallenge" FORCE ROW LEVEL SECURITY;
ALTER TABLE "IdentityAssuranceSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityAssuranceSnapshot" FORCE ROW LEVEL SECURITY;
ALTER TABLE "IdentityContinuityEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityContinuityEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "IdentityContinuityConflict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityContinuityConflict" FORCE ROW LEVEL SECURITY;

CREATE POLICY "identitycontinuitystate_tenant_isolation" ON "IdentityContinuityState" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "offlineidentitychallenge_tenant_isolation" ON "OfflineIdentityChallenge" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "identityassurancesnapshot_tenant_isolation" ON "IdentityAssuranceSnapshot" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "identitycontinuityevent_tenant_isolation" ON "IdentityContinuityEvent" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY "identitycontinuityconflict_tenant_isolation" ON "IdentityContinuityConflict" USING ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("organizationId" = current_setting('app.organization_id', true) AND "tenantId" = current_setting('app.tenant_id', true));
