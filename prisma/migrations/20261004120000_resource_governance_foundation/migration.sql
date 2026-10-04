-- Additive only: existing surface entitlements remain unbound and keep their meaning.
ALTER TYPE "ResourceType" ADD VALUE 'SERVICE';
ALTER TYPE "ResourceType" ADD VALUE 'DEVICE';
ALTER TYPE "ResourceType" ADD VALUE 'WORKLOAD';
ALTER TYPE "ResourceType" ADD VALUE 'AI_AGENT';
ALTER TABLE "Resource" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Entitlement" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Entitlement" ADD COLUMN "resourceScopeId" TEXT;
CREATE UNIQUE INDEX "Resource_organizationId_tenantId_id_key" ON "Resource"("organizationId","tenantId","id");
CREATE TYPE "ResourceScopeKind" AS ENUM ('RESOURCE','RESOURCE_GROUP','TENANT');
CREATE TABLE "ResourceScope" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "kind" "ResourceScopeKind" NOT NULL,
  "resourceId" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResourceScope_kind_target_check" CHECK (("kind"='RESOURCE' AND "resourceId" IS NOT NULL) OR ("kind" IN ('RESOURCE_GROUP','TENANT') AND "resourceId" IS NULL)),
  CONSTRAINT "ResourceScope_tenant_fk" FOREIGN KEY ("organizationId","tenantId") REFERENCES "Tenant"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "ResourceScope_resource_fk" FOREIGN KEY ("organizationId","tenantId","resourceId") REFERENCES "Resource"("organizationId","tenantId","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "ResourceScope_organizationId_tenantId_id_key" ON "ResourceScope"("organizationId","tenantId","id");
CREATE UNIQUE INDEX "ResourceScope_organizationId_tenantId_key_key" ON "ResourceScope"("organizationId","tenantId","key");
CREATE TABLE "ResourceScopeMember" (
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  PRIMARY KEY ("organizationId","tenantId","scopeId","resourceId"),
  CONSTRAINT "ResourceScopeMember_scope_fk" FOREIGN KEY ("organizationId","tenantId","scopeId") REFERENCES "ResourceScope"("organizationId","tenantId","id") ON DELETE RESTRICT,
  CONSTRAINT "ResourceScopeMember_resource_fk" FOREIGN KEY ("organizationId","tenantId","resourceId") REFERENCES "Resource"("organizationId","tenantId","id") ON DELETE RESTRICT
);
CREATE INDEX "ResourceScopeMember_resource_idx" ON "ResourceScopeMember"("organizationId","tenantId","resourceId");
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_resource_scope_fk" FOREIGN KEY ("organizationId","tenantId","resourceScopeId") REFERENCES "ResourceScope"("organizationId","tenantId","id") ON DELETE RESTRICT;
CREATE INDEX "Entitlement_resource_scope_idx" ON "Entitlement"("organizationId","tenantId","resourceScopeId");
ALTER TABLE "ResourceScope" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResourceScope" FORCE ROW LEVEL SECURITY;
CREATE POLICY "resource_scope_tenant_isolation" ON "ResourceScope"
USING ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true))
WITH CHECK ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true));
ALTER TABLE "ResourceScopeMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResourceScopeMember" FORCE ROW LEVEL SECURITY;
CREATE POLICY "resource_scope_member_tenant_isolation" ON "ResourceScopeMember"
USING ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true))
WITH CHECK ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    GRANT SELECT, INSERT ON "ResourceScope", "ResourceScopeMember" TO app_user;
  END IF;
END $$;
-- No business data, entitlement or assignment seeds. No changes to legacy tables.
