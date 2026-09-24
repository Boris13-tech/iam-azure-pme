-- CreateEnum
CREATE TYPE "AssignmentSource" AS ENUM ('LEGACY_ROLE', 'DIRECT', 'PROVIDER', 'POLICY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "source" "AssignmentSource" NOT NULL,
    "sourceRef" TEXT,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Entitlement_organizationId_tenantId_idx" ON "Entitlement"("organizationId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_organizationId_tenantId_id_key" ON "Entitlement"("organizationId", "tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_organizationId_tenantId_key_key" ON "Entitlement"("organizationId", "tenantId", "key");

-- CreateIndex
CREATE INDEX "Assignment_organizationId_tenantId_subjectId_status_idx" ON "Assignment"("organizationId", "tenantId", "subjectId", "status");

-- CreateIndex
CREATE INDEX "Assignment_organizationId_tenantId_entitlementId_idx" ON "Assignment"("organizationId", "tenantId", "entitlementId");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_organizationId_tenantId_id_key" ON "Assignment"("organizationId", "tenantId", "id");

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_organizationId_tenantId_subjectId_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_organizationId_tenantId_entitlementId_fkey" FOREIGN KEY ("organizationId", "tenantId", "entitlementId") REFERENCES "Entitlement"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add partial unique index for active grants
CREATE UNIQUE INDEX "Assignment_active_grant_unique"
ON "Assignment" (
  "organizationId",
  "tenantId",
  "subjectId",
  "entitlementId",
  "source",
  COALESCE("sourceRef", '')
)
WHERE "status" = 'ACTIVE';

-- Add temporal check constraint
ALTER TABLE "Assignment"
ADD CONSTRAINT "Assignment_valid_time_range"
CHECK (
  "validUntil" IS NULL
  OR "validFrom" IS NULL
  OR "validUntil" > "validFrom"
);

-- Enable and Force RLS for Entitlement
ALTER TABLE "Entitlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Entitlement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "entitlement_tenant_isolation" ON "Entitlement"
USING (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
)
WITH CHECK (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
);

-- Enable and Force RLS for Assignment
ALTER TABLE "Assignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Assignment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "assignment_tenant_isolation" ON "Assignment"
USING (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
)
WITH CHECK (
  "organizationId" = current_setting('app.organization_id', true)
  AND "tenantId" = current_setting('app.tenant_id', true)
);

