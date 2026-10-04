-- Static, tenant-scoped entitlement exclusion. No seeds or legacy changes.
CREATE TYPE "SoDPolicyStatus" AS ENUM ('ACTIVE','DISABLED');
CREATE TYPE "SoDConflictType" AS ENUM ('MUTUALLY_EXCLUSIVE');
CREATE TYPE "SoDEnforcement" AS ENUM ('DENY');
CREATE TABLE "SoDPolicy" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "tenantId" TEXT NOT NULL,
 "key" TEXT NOT NULL, "scopeId" TEXT NOT NULL,
 "status" "SoDPolicyStatus" NOT NULL DEFAULT 'DISABLED',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE ("organizationId","tenantId","id"), UNIQUE ("organizationId","tenantId","key"),
 FOREIGN KEY ("organizationId","tenantId","scopeId") REFERENCES "ResourceScope"("organizationId","tenantId","id") ON DELETE RESTRICT
);
CREATE INDEX "SoDPolicy_scope_idx" ON "SoDPolicy"("organizationId","tenantId","status","scopeId");
CREATE TABLE "SoDRule" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "tenantId" TEXT NOT NULL,
 "policyId" TEXT NOT NULL, "entitlementAId" TEXT NOT NULL, "entitlementBId" TEXT NOT NULL,
 "conflictType" "SoDConflictType" NOT NULL DEFAULT 'MUTUALLY_EXCLUSIVE',
 "enforcement" "SoDEnforcement" NOT NULL DEFAULT 'DENY', "enabled" BOOLEAN NOT NULL DEFAULT true,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE ("organizationId","tenantId","id"),
 UNIQUE ("organizationId","tenantId","policyId","entitlementAId","entitlementBId"),
 CHECK ("entitlementAId" < "entitlementBId"),
 FOREIGN KEY ("organizationId","tenantId","policyId") REFERENCES "SoDPolicy"("organizationId","tenantId","id") ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId","tenantId","entitlementAId") REFERENCES "Entitlement"("organizationId","tenantId","id") ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId","tenantId","entitlementBId") REFERENCES "Entitlement"("organizationId","tenantId","id") ON DELETE RESTRICT
);
CREATE INDEX "SoDRule_entitlements_idx" ON "SoDRule"("organizationId","tenantId","entitlementAId","entitlementBId");
ALTER TABLE "SoDPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SoDPolicy" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SoDRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SoDRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY sod_policy_scope ON "SoDPolicy"
 USING ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true))
 WITH CHECK ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true));
CREATE POLICY sod_rule_scope ON "SoDRule"
 USING ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true))
 WITH CHECK ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true));
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT SELECT,INSERT,UPDATE ON "SoDPolicy","SoDRule" TO app_user;
END IF; END $$;

-- Security invoker: the runtime must obey RLS inside every query too.
CREATE FUNCTION luxia_sod_scope_contains(org TEXT, tenant TEXT, scope TEXT, resource TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM "ResourceScope" s WHERE s."organizationId"=org AND s."tenantId"=tenant AND s.id=scope
 AND (s.kind='TENANT' OR (s.kind='RESOURCE' AND s."resourceId"=resource) OR
 (s.kind='RESOURCE_GROUP' AND EXISTS(SELECT 1 FROM "ResourceScopeMember" m WHERE m."organizationId"=org AND m."tenantId"=tenant AND m."scopeId"=s.id AND m."resourceId"=resource))))
$$;
CREATE FUNCTION luxia_sod_assignment_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('resource-governance:'||NEW."organizationId"||':'||NEW."tenantId",0));
 IF NEW.status <> 'ACTIVE' OR NEW.source='LEGACY_ROLE' THEN RETURN NEW; END IF;
 IF EXISTS (
 SELECT 1 FROM "SoDRule" rule JOIN "SoDPolicy" p ON p.id=rule."policyId" AND p."organizationId"=rule."organizationId" AND p."tenantId"=rule."tenantId"
 JOIN "Entitlement" e ON e.id=NEW."entitlementId" AND e."organizationId"=NEW."organizationId" AND e."tenantId"=NEW."tenantId"
 JOIN "Assignment" a ON a."subjectId"=NEW."subjectId" AND a."organizationId"=NEW."organizationId" AND a."tenantId"=NEW."tenantId"
 JOIN "Entitlement" other ON other.id=a."entitlementId" AND other."organizationId"=a."organizationId" AND other."tenantId"=a."tenantId"
 JOIN "Resource" r ON r."organizationId"=NEW."organizationId" AND r."tenantId"=NEW."tenantId"
 WHERE rule."organizationId"=NEW."organizationId" AND rule."tenantId"=NEW."tenantId" AND rule.enabled AND p.status='ACTIVE'
 AND a.id<>NEW.id AND a.status='ACTIVE' AND a.source<>'LEGACY_ROLE'
 AND ((rule."entitlementAId"=e.id AND rule."entitlementBId"=other.id) OR (rule."entitlementBId"=e.id AND rule."entitlementAId"=other.id))
 AND coalesce(a."validUntil",'infinity'::timestamp)>greatest(coalesce(NEW."validFrom",CURRENT_TIMESTAMP),CURRENT_TIMESTAMP)
 AND coalesce(NEW."validUntil",'infinity'::timestamp)>greatest(coalesce(a."validFrom",CURRENT_TIMESTAMP),CURRENT_TIMESTAMP)
 AND luxia_sod_scope_contains(NEW."organizationId",NEW."tenantId",e."resourceScopeId",r.id)
 AND luxia_sod_scope_contains(NEW."organizationId",NEW."tenantId",other."resourceScopeId",r.id)
 AND luxia_sod_scope_contains(NEW."organizationId",NEW."tenantId",p."scopeId",r.id)
 ) THEN RAISE EXCEPTION 'SOD_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assignment_static_sod BEFORE INSERT OR UPDATE ON "Assignment" FOR EACH ROW EXECUTE FUNCTION luxia_sod_assignment_guard();
