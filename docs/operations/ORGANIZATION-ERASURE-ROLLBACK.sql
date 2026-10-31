-- Rollback of 20261023140000_organization_erasure (R7). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Restores the nine guards exactly as before (no erasure gate) and removes the erasure functions. It refuses once an
-- organization has been erased: the OrganizationErasure records are then the only trace of it (forward fix only).
-- The table lock waits for an erasure in flight, so its record is seen. row_security = off makes the check fail with an
-- error, rather than see nothing, for a role that row-level security would filter.
-- If the job died while the migration ran, Prisma's record can say "not finished" with the objects present or absent.
-- Read the catalog first: `migrate resolve --rolled-back` is right only when they are absent.
SET lock_timeout = '5s';
SET LOCAL row_security = off;
LOCK TABLE "OrganizationErasure" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "OrganizationErasure") THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_ERASURE_RECORDED';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION luxia_review_immutable_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
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

CREATE OR REPLACE FUNCTION luxia_resource_onboarding_evidence_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."operation" LIKE 'RESOURCE.ONBOARDING.%'
     OR OLD."operation" LIKE 'RESOURCE.CAPABILITY.%'
     OR (TG_OP = 'UPDATE' AND
       (NEW."operation" LIKE 'RESOURCE.ONBOARDING.%' OR NEW."operation" LIKE 'RESOURCE.CAPABILITY.%'))
  THEN
    RAISE EXCEPTION 'RESOURCE_ONBOARDING_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_signup_code_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SIGNUP_CODE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('CONSUMED', 'REVOKED', 'EXPIRED')
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."codeHash" IS DISTINCT FROM OLD."codeHash"
     OR NEW."issuedBy" IS DISTINCT FROM OLD."issuedBy" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (NEW."status" = 'CONSUMED' AND OLD."expiresAt" <= (now() AT TIME ZONE 'UTC')) THEN
    RAISE EXCEPTION 'SIGNUP_CODE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_invitation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INVITATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."acceptedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL
       OR NEW."pendingChallengeHash" IS NOT NULL OR NEW."pendingExpiresAt" IS NOT NULL THEN
      RAISE EXCEPTION 'INVITATION_INVALID_INITIAL_STATE' USING ERRCODE = '23514';
    END IF;
    PERFORM luxia_organization_lock_active(NEW."organizationId");
    NEW."createdAt" := v_now;
    NEW."updatedAt" := v_now;
    IF NEW."issuedByOperatorChangeId" IS NOT NULL THEN
      IF NOT coalesce((SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user), false) THEN
        RAISE EXCEPTION 'INVITATION_OPERATOR_ONLY' USING ERRCODE = '42501';
      END IF;
      NEW."expiresAt" := v_now + interval '24 hours';
    ELSE
      NEW."expiresAt" := v_now + interval '7 days';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."acceptedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."subjectId" IS DISTINCT FROM OLD."subjectId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR NEW."role" IS DISTINCT FROM OLD."role"
     OR NEW."invitedBySubjectId" IS DISTINCT FROM OLD."invitedBySubjectId"
     OR NEW."issuedByOperatorChangeId" IS DISTINCT FROM OLD."issuedByOperatorChangeId"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'INVITATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."acceptedAt" IS NOT NULL AND OLD."expiresAt" <= v_now THEN
    RAISE EXCEPTION 'INVITATION_EXPIRED' USING ERRCODE = '23514';
  END IF;
  IF NEW."acceptedAt" IS NOT NULL
     OR (NEW."pendingChallengeHash" IS NOT NULL AND NEW."pendingChallengeHash" IS DISTINCT FROM OLD."pendingChallengeHash") THEN
    PERFORM luxia_organization_lock_active(NEW."organizationId");
  END IF;
  IF NEW."acceptedAt" IS NOT NULL AND NEW."issuedByOperatorChangeId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "CanonicalAdminAuditEvent" e
    WHERE e."organizationId" = NEW."organizationId" AND e."tenantId" = NEW."tenantId"
      AND e."changeId" = NEW."issuedByOperatorChangeId" AND e."operation" = 'BREAK_GLASS.RECOVERY_INVITATION.ISSUE'
      AND e."result" = 'SUCCESS' AND e."metadata"->>'invitationId' = NEW."id") THEN
    RAISE EXCEPTION 'INVITATION_OPERATOR_AUTHORITY_MISSING' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_organization_domain_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ORGANIZATION_DOMAIN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM luxia_organization_lock_active(NEW."organizationId");
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."domain" IS DISTINCT FROM OLD."domain"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ORGANIZATION_DOMAIN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'VERIFIED' AND OLD."status" IS DISTINCT FROM 'VERIFIED' THEN
    PERFORM luxia_organization_lock_active(NEW."organizationId");
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_recovery_code_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_usable INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RECOVERY_CODE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."usedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."batchId" IS NULL THEN
      RAISE EXCEPTION 'RECOVERY_CODE_INVALID_INITIAL_STATE' USING ERRCODE = '23514';
    END IF;
    PERFORM luxia_organization_lock_active(NEW."organizationId");
    -- Concurrent batches of one account are serialized on its local identity row, so the count
    -- below sees every committed code.
    PERFORM 1 FROM "LocalIdentity"
      WHERE "organizationId" = NEW."organizationId" AND "tenantId" = NEW."tenantId" AND "identityAccountId" = NEW."identityAccountId"
      FOR NO KEY UPDATE;
    SELECT count(*) INTO v_usable FROM "LocalRecoveryCode"
      WHERE "organizationId" = NEW."organizationId" AND "tenantId" = NEW."tenantId" AND "identityAccountId" = NEW."identityAccountId"
        AND "usedAt" IS NULL AND "revokedAt" IS NULL;
    IF v_usable >= 10 THEN
      RAISE EXCEPTION 'RECOVERY_CODE_LIMIT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."usedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'RECOVERY_CODE_FROZEN' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."id", NEW."organizationId", NEW."tenantId", NEW."identityAccountId", NEW."codeHash", NEW."batchId", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD."id", OLD."organizationId", OLD."tenantId", OLD."identityAccountId", OLD."codeHash", OLD."batchId", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'RECOVERY_CODE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF (NEW."usedAt" IS NULL) = (NEW."revokedAt" IS NULL) THEN
    -- Neither changed (no-op update) or both in one statement: refused either way.
    RAISE EXCEPTION 'RECOVERY_CODE_ONE_CHANGE' USING ERRCODE = '23514';
  END IF;
  IF NEW."usedAt" IS NOT NULL THEN
    PERFORM luxia_organization_lock_active(NEW."organizationId"); -- a code is consumed only for an ACTIVE organization
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_audit_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY' USING ERRCODE = '23514',
    DETAIL = format('%s on %s is not allowed: the audit trail is append-only', TG_OP, TG_TABLE_NAME);
END $$;

CREATE OR REPLACE FUNCTION luxia_provider_connection_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_tenants INTEGER;
  v_unlocked INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('DRAFT', 'ACTIVE') OR (NEW."providerType" = 'LUXIA_LOCAL' AND NEW."status" <> 'ACTIVE') THEN
      RAISE EXCEPTION 'PROVIDER_CONNECTION_STATUS_INITIAL' USING ERRCODE = '23514';
    END IF;
    NEW."statusChangedAt" := NULL;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."providerType" IS DISTINCT FROM OLD."providerType" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."externalScopeId" IS DISTINCT FROM OLD."externalScopeId" AND OLD."status" NOT IN ('DRAFT', 'TESTING') THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_SCOPE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    NEW."statusChangedAt" := OLD."statusChangedAt";
    RETURN NEW;
  END IF;
  IF OLD."providerType" = 'LUXIA_LOCAL' THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_LOCAL_ALWAYS_ACTIVE' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'TESTING')
       OR (OLD."status" = 'TESTING' AND NEW."status" = 'ACTIVE')
       OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('DISABLED', 'QUARANTINED'))
       OR (OLD."status" = 'DISABLED' AND NEW."status" IN ('ACTIVE', 'QUARANTINED'))
       OR (OLD."status" = 'QUARANTINED' AND NEW."status" = 'DISABLED')) THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_STATUS_TRANSITION' USING ERRCODE = '23514';
  END IF;
  -- Checked, never taken here (taking it after the row lock would invert the lock order), as in B3.
  -- A bigint advisory key shows its high half in classid, its low half in objid, objsubid = 1.
  SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM pg_locks l
           WHERE l.locktype = 'advisory' AND l.granted AND l.pid = pg_backend_pid() AND l.objsubid = 1
             AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
             AND l.classid::bigint = ((h.k >> 32) & 4294967295) AND l.objid::bigint = (h.k & 4294967295)))
    INTO v_tenants, v_unlocked
  FROM "Tenant" t
  CROSS JOIN LATERAL (SELECT hashtextextended('resource-governance:' || NEW."organizationId" || ':' || t."id", 0) AS k) h
  WHERE t."organizationId" = NEW."organizationId";
  IF v_tenants = 0 OR v_unlocked > 0 THEN
    RAISE EXCEPTION 'GOVERNANCE_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  NEW."statusChangedAt" := (now() AT TIME ZONE 'UTC');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_provider_secret_reference_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_org TEXT;
  v_tenants INTEGER;
  v_unlocked INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PROVIDER_SECRET_REFERENCE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROVIDER_SECRET_REFERENCE_REVOKED' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW."id", NEW."organizationId", NEW."providerConnectionId", NEW."purpose", NEW."store", NEW."locator", NEW."createdAt")
       IS DISTINCT FROM ROW(OLD."id", OLD."organizationId", OLD."providerConnectionId", OLD."purpose", OLD."store", OLD."locator", OLD."createdAt") THEN
      RAISE EXCEPTION 'PROVIDER_SECRET_REFERENCE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF NEW."activeVersion" IS DISTINCT FROM OLD."activeVersion" THEN
      IF OLD."candidateVersion" IS NULL OR NEW."activeVersion" IS DISTINCT FROM OLD."candidateVersion" OR NEW."candidateVersion" IS NOT NULL THEN
        RAISE EXCEPTION 'PROVIDER_SECRET_REFERENCE_PROMOTION_ONLY' USING ERRCODE = '23514';
      END IF;
      NEW."rotatedAt" := (now() AT TIME ZONE 'UTC');
    ELSE
      NEW."rotatedAt" := OLD."rotatedAt";
    END IF;
    IF NEW."revokedAt" IS NOT NULL THEN
      NEW."revokedAt" := (now() AT TIME ZONE 'UTC');
    END IF;
  ELSE
    IF NEW."revokedAt" IS NOT NULL OR NEW."rotatedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROVIDER_SECRET_REFERENCE_INITIAL' USING ERRCODE = '23514';
    END IF;
  END IF;
  v_org := NEW."organizationId";
  SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM pg_locks l
           WHERE l.locktype = 'advisory' AND l.granted AND l.pid = pg_backend_pid() AND l.objsubid = 1
             AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
             AND l.classid::bigint = ((h.k >> 32) & 4294967295) AND l.objid::bigint = (h.k & 4294967295)))
    INTO v_tenants, v_unlocked
  FROM "Tenant" t
  CROSS JOIN LATERAL (SELECT hashtextextended('resource-governance:' || v_org || ':' || t."id", 0) AS k) h
  WHERE t."organizationId" = v_org;
  IF v_tenants = 0 OR v_unlocked > 0 THEN
    RAISE EXCEPTION 'GOVERNANCE_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION luxia_organization_erase(TEXT);
DROP FUNCTION luxia_erasure_allowed(TEXT, OID);
DROP TABLE "OrganizationErasure";
ALTER TABLE "AuthorizationShadowObservation" DROP CONSTRAINT "AuthorizationShadowObservation_organizationId_fkey";
ALTER TABLE "AuthTransaction" DROP CONSTRAINT "AuthTransaction_expectedOrganizationId_fkey";
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023140000_organization_erasure';
  END IF;
END $$;
RESET lock_timeout;
