-- Additive review snapshots. No provisioning, seeds or legacy changes.
CREATE TYPE "AccessReviewCampaignStatus" AS ENUM ('OPEN','COMPLETED');
CREATE TYPE "AccessReviewDecision" AS ENUM ('PENDING','KEEP','REVOKE');
CREATE TYPE "AccessReviewState" AS ENUM ('PENDING','REQUIRES_REMEDIATION','DECIDED');
CREATE TABLE "AccessReviewCampaign" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "tenantId" TEXT NOT NULL,
 "name" TEXT NOT NULL, "scopeId" TEXT NOT NULL, "scopeType" "ResourceScopeKind" NOT NULL, "resourceId" TEXT,
 "reviewerSubjectId" TEXT NOT NULL, "reviewerStrategy" TEXT NOT NULL DEFAULT 'EXPLICIT_SINGLE',
 "createdBySubjectId" TEXT NOT NULL, "startsAt" TIMESTAMP(3) NOT NULL, "dueAt" TIMESTAMP(3) NOT NULL,
 "status" "AccessReviewCampaignStatus" NOT NULL DEFAULT 'OPEN', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
 UNIQUE("organizationId","tenantId","id"), UNIQUE("organizationId","tenantId","id","reviewerSubjectId"),
 CHECK("startsAt" < "dueAt"), CHECK("reviewerStrategy"='EXPLICIT_SINGLE'),
 CHECK(("status"='OPEN' AND "completedAt" IS NULL) OR ("status"='COMPLETED' AND "completedAt" IS NOT NULL)),
 CHECK(("scopeType"='RESOURCE' AND "resourceId" IS NOT NULL) OR ("scopeType"<>'RESOURCE' AND "resourceId" IS NULL)),
 FOREIGN KEY("organizationId","tenantId","scopeId") REFERENCES "ResourceScope"("organizationId","tenantId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","tenantId","resourceId") REFERENCES "Resource"("organizationId","tenantId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","tenantId","reviewerSubjectId") REFERENCES "Subject"("organizationId","tenantId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","tenantId","createdBySubjectId") REFERENCES "Subject"("organizationId","tenantId","id") ON DELETE RESTRICT
);
CREATE INDEX "AccessReviewCampaign_organizationId_tenantId_status_dueAt_idx" ON "AccessReviewCampaign"("organizationId","tenantId","status","dueAt");
CREATE TABLE "AccessReviewItem" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "campaignId" TEXT NOT NULL,
 "subjectId" TEXT NOT NULL, "assignmentId" TEXT NOT NULL, "entitlementId" TEXT NOT NULL, "resourceId" TEXT,
 "scopeId" TEXT NOT NULL, "resourceIds" TEXT[] NOT NULL, "assignmentVersion" TIMESTAMP(3) NOT NULL, "entitlementVersion" TIMESTAMP(3) NOT NULL,
 "reviewerSubjectId" TEXT NOT NULL, "decision" "AccessReviewDecision" NOT NULL DEFAULT 'PENDING',
 "reviewState" "AccessReviewState" NOT NULL DEFAULT 'PENDING', "observedAssignmentState" TEXT NOT NULL DEFAULT 'ACTIVE',
 "decidedAt" TIMESTAMP(3), "justification" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("organizationId","tenantId","id"), UNIQUE("organizationId","tenantId","campaignId","assignmentId"),
 CHECK("reviewerSubjectId" <> "subjectId"), CHECK(cardinality("resourceIds")>0),
 CHECK("observedAssignmentState" IN ('ACTIVE','REVOKED','EXPIRED','INACTIVE','CHANGED')),
 CHECK(("decision"='PENDING' AND "decidedAt" IS NULL AND "justification" IS NULL AND "reviewState"<>'DECIDED') OR
 ("decision"<>'PENDING' AND "decidedAt" IS NOT NULL AND "reviewState"='DECIDED' AND length("justification") BETWEEN 3 AND 2000)),
 FOREIGN KEY("organizationId","tenantId","campaignId","reviewerSubjectId") REFERENCES "AccessReviewCampaign"("organizationId","tenantId","id","reviewerSubjectId") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","tenantId","subjectId") REFERENCES "Subject"("organizationId","tenantId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","tenantId","assignmentId") REFERENCES "Assignment"("organizationId","tenantId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","tenantId","entitlementId") REFERENCES "Entitlement"("organizationId","tenantId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","tenantId","scopeId") REFERENCES "ResourceScope"("organizationId","tenantId","id") ON DELETE RESTRICT,
 FOREIGN KEY("organizationId","tenantId","resourceId") REFERENCES "Resource"("organizationId","tenantId","id") ON DELETE RESTRICT
);
CREATE INDEX "AccessReviewItem_organizationId_tenantId_reviewerSubjectId_dec_idx" ON "AccessReviewItem"("organizationId","tenantId","reviewerSubjectId","decision","id");
ALTER TABLE "AccessReviewCampaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccessReviewCampaign" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AccessReviewItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccessReviewItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY review_campaign_scope ON "AccessReviewCampaign" USING ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true)) WITH CHECK ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true));
CREATE POLICY review_item_scope ON "AccessReviewItem" USING ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true)) WITH CHECK ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true));
CREATE FUNCTION luxia_review_immutable_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'REVIEW_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='AccessReviewItem' THEN
  IF OLD.decision<>'PENDING' OR (to_jsonb(NEW)-ARRAY['decision','reviewState','observedAssignmentState','decidedAt','justification']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['decision','reviewState','observedAssignmentState','decidedAt','justification']) THEN RAISE EXCEPTION 'REVIEW_IMMUTABLE'; END IF;
 ELSE
  IF OLD.status<>'OPEN' OR (to_jsonb(NEW)-ARRAY['status','completedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','completedAt']) THEN RAISE EXCEPTION 'REVIEW_IMMUTABLE'; END IF;
  IF NEW.status='COMPLETED' AND EXISTS(SELECT 1 FROM "AccessReviewItem" WHERE "campaignId"=OLD.id AND "organizationId"=OLD."organizationId" AND "tenantId"=OLD."tenantId" AND decision='PENDING') THEN RAISE EXCEPTION 'REVIEW_ITEMS_PENDING'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_review_immutable_guard() FROM PUBLIC;
CREATE TRIGGER review_campaign_immutable BEFORE UPDATE OR DELETE ON "AccessReviewCampaign" FOR EACH ROW EXECUTE FUNCTION luxia_review_immutable_guard();
CREATE TRIGGER review_item_immutable BEFORE UPDATE OR DELETE ON "AccessReviewItem" FOR EACH ROW EXECUTE FUNCTION luxia_review_immutable_guard();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON "AccessReviewCampaign","AccessReviewItem" FROM app_user;
 GRANT SELECT,INSERT,UPDATE ON "AccessReviewCampaign","AccessReviewItem" TO app_user;
END IF; END $$;
