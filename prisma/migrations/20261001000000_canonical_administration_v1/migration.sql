-- Canonical Administration v1
-- Additive only. Legacy Role, Permission, UserRole, AccessPolicy, and AuditLog
-- are deliberately untouched.

CREATE TYPE "IdentityAccountStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "CanonicalAdminResult" AS ENUM ('SUCCESS', 'DENIED', 'FAILURE');

ALTER TABLE "IdentityAccount"
  ADD COLUMN "status" "IdentityAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "disabledAt" TIMESTAMP(3);

ALTER TABLE "IdentityAccount"
  ADD CONSTRAINT "IdentityAccount_disabled_state_consistency"
  CHECK (
    ("status" = 'ACTIVE' AND "disabledAt" IS NULL)
    OR ("status" = 'DISABLED' AND "disabledAt" IS NOT NULL)
  );

CREATE TABLE "CanonicalAdminAuditEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "actorSubjectId" TEXT NOT NULL,
  "targetSubjectId" TEXT,
  "operation" TEXT NOT NULL,
  "roleKey" TEXT,
  "roleVersion" INTEGER,
  "assignmentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "changeId" TEXT NOT NULL,
  "result" "CanonicalAdminResult" NOT NULL,
  "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CanonicalAdminAuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CanonicalAdminAuditEvent_operation_nonempty" CHECK (btrim("operation") <> ''),
  CONSTRAINT "CanonicalAdminAuditEvent_change_id_nonempty" CHECK (btrim("changeId") <> ''),
  CONSTRAINT "CanonicalAdminAuditEvent_role_pair" CHECK (
    ("roleKey" IS NULL AND "roleVersion" IS NULL)
    OR ("roleKey" IS NOT NULL AND btrim("roleKey") <> '' AND "roleVersion" IS NOT NULL AND "roleVersion" > 0)
  )
);

CREATE UNIQUE INDEX "CanonicalAdminAuditEvent_organizationId_tenantId_id_key"
  ON "CanonicalAdminAuditEvent"("organizationId", "tenantId", "id");
CREATE UNIQUE INDEX "CanonicalAdminAuditEvent_organizationId_tenantId_changeId_key"
  ON "CanonicalAdminAuditEvent"("organizationId", "tenantId", "changeId");
CREATE INDEX "CanonicalAdminAuditEvent_scope_occurredAt_idx"
  ON "CanonicalAdminAuditEvent"("organizationId", "tenantId", "occurredAt");
CREATE INDEX "CanonicalAdminAuditEvent_actor_occurredAt_idx"
  ON "CanonicalAdminAuditEvent"("organizationId", "tenantId", "actorSubjectId", "occurredAt");
CREATE INDEX "CanonicalAdminAuditEvent_target_occurredAt_idx"
  ON "CanonicalAdminAuditEvent"("organizationId", "tenantId", "targetSubjectId", "occurredAt");
CREATE INDEX "CanonicalAdminAuditEvent_operation_occurredAt_idx"
  ON "CanonicalAdminAuditEvent"("organizationId", "tenantId", "operation", "occurredAt");
CREATE INDEX "CanonicalAdminAuditEvent_role_idx"
  ON "CanonicalAdminAuditEvent"("organizationId", "tenantId", "roleKey", "roleVersion");

ALTER TABLE "CanonicalAdminAuditEvent"
  ADD CONSTRAINT "CanonicalAdminAuditEvent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CanonicalAdminAuditEvent"
  ADD CONSTRAINT "CanonicalAdminAuditEvent_organizationId_tenantId_fkey"
  FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CanonicalAdminAuditEvent"
  ADD CONSTRAINT "CanonicalAdminAuditEvent_actor_fkey"
  FOREIGN KEY ("organizationId", "tenantId", "actorSubjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CanonicalAdminAuditEvent"
  ADD CONSTRAINT "CanonicalAdminAuditEvent_target_fkey"
  FOREIGN KEY ("organizationId", "tenantId", "targetSubjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProviderConnectionTenantScope" (
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerConnectionId" TEXT NOT NULL,
  "displayName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProviderConnectionTenantScope_pkey"
    PRIMARY KEY ("organizationId", "tenantId", "providerConnectionId")
);

CREATE INDEX "ProviderConnectionTenantScope_provider_idx"
  ON "ProviderConnectionTenantScope"("organizationId", "providerConnectionId");

ALTER TABLE "ProviderConnectionTenantScope"
  ADD CONSTRAINT "ProviderConnectionTenantScope_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderConnectionTenantScope"
  ADD CONSTRAINT "ProviderConnectionTenantScope_tenant_fkey"
  FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderConnectionTenantScope"
  ADD CONSTRAINT "ProviderConnectionTenantScope_provider_fkey"
  FOREIGN KEY ("organizationId", "providerConnectionId") REFERENCES "ProviderConnection"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing provider connections are organization-owned. A deterministic
-- tenant projection is safe only when the organization has exactly one
-- tenant. Any ambiguous pre-existing provider fails the migration closed so
-- an operator must provide an explicit mapping instead of guessing.
INSERT INTO "ProviderConnectionTenantScope" (
  "organizationId",
  "tenantId",
  "providerConnectionId",
  "displayName"
)
SELECT
  pc."organizationId",
  min(t."id") AS "tenantId",
  pc."id" AS "providerConnectionId",
  pc."name" AS "displayName"
FROM "ProviderConnection" pc
JOIN "Tenant" t ON t."organizationId" = pc."organizationId"
GROUP BY pc."organizationId", pc."id", pc."name"
HAVING count(*) = 1
ON CONFLICT ("organizationId", "tenantId", "providerConnectionId") DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ProviderConnection" pc
    LEFT JOIN "ProviderConnectionTenantScope" scope
      ON scope."organizationId" = pc."organizationId"
     AND scope."providerConnectionId" = pc."id"
    WHERE scope."providerConnectionId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Ambiguous or orphaned ProviderConnection tenant scope';
  END IF;
END
$$;

ALTER TABLE "CanonicalAdminAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CanonicalAdminAuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "canonical_admin_audit_tenant_isolation" ON "CanonicalAdminAuditEvent"
USING (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
)
WITH CHECK (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
);

ALTER TABLE "ProviderConnectionTenantScope" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderConnectionTenantScope" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_connection_scope_tenant_isolation" ON "ProviderConnectionTenantScope"
USING (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
)
WITH CHECK (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
);

-- Runtime access is explicit and remains constrained by forced RLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "CanonicalAdminAuditEvent" TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ProviderConnectionTenantScope" TO app_user;
  END IF;
END
$$;
