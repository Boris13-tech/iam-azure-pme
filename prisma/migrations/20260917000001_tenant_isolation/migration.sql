-- DropForeignKey
ALTER TABLE "IdentityAccount" DROP CONSTRAINT "IdentityAccount_organizationId_subjectId_fkey";

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_organizationId_subjectId_fkey";

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_organizationId_identityAccountId_fkey";

-- DropIndex
DROP INDEX "IdentityAccount_organizationId_subjectId_idx";

-- Add nullable tenantId
ALTER TABLE "IdentityAccount" ADD COLUMN "tenantId" TEXT;

-- Backfill IdentityAccount tenantId
UPDATE "IdentityAccount" ia 
SET "tenantId" = s."tenantId" 
FROM "Subject" s 
WHERE s."id" = ia."subjectId" AND s."organizationId" = ia."organizationId";

-- Enforce NOT NULL
ALTER TABLE "IdentityAccount" ALTER COLUMN "tenantId" SET NOT NULL;

-- Clear transient transactions to allow NOT NULL
DELETE FROM "AuthTransaction";

-- AlterTable AuthTransaction
ALTER TABLE "AuthTransaction" ADD COLUMN "expectedTenantId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Subject_organizationId_tenantId_id_key" ON "Subject"("organizationId", "tenantId", "id");

-- CreateIndex
CREATE INDEX "IdentityAccount_organizationId_tenantId_subjectId_idx" ON "IdentityAccount"("organizationId", "tenantId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityAccount_organizationId_tenantId_subjectId_id_key" ON "IdentityAccount"("organizationId", "tenantId", "subjectId", "id");

-- AddForeignKey
ALTER TABLE "IdentityAccount" ADD CONSTRAINT "IdentityAccount_organizationId_tenantId_subjectId_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_organizationId_tenantId_subjectId_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_organizationId_tenantId_subjectId_identityAccountI_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId", "identityAccountId") REFERENCES "IdentityAccount"("organizationId", "tenantId", "subjectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4E PostgreSQL RLS Policies
ALTER TABLE "Subject" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subject" FORCE ROW LEVEL SECURITY;
CREATE POLICY "subject_tenant_isolation" ON "Subject"
USING (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
)
WITH CHECK (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
);

ALTER TABLE "IdentityAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY "identityaccount_tenant_isolation" ON "IdentityAccount"
USING (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
)
WITH CHECK (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
);

ALTER TABLE "Resource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Resource" FORCE ROW LEVEL SECURITY;
CREATE POLICY "resource_tenant_isolation" ON "Resource"
USING (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
)
WITH CHECK (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
);

ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Session" FORCE ROW LEVEL SECURITY;
CREATE POLICY "session_tenant_isolation" ON "Session"
USING (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
)
WITH CHECK (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
);
