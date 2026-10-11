-- Rollback of 20261011180000_organization_status_session_scope (design section 8).
-- Run as the owner, in ONE transaction:  psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Lossless only while every organization is ACTIVE and no RECOVERY session exists: it refuses
-- otherwise, and the only option is then a forward fix (a closed organization must never reopen).
-- It restores the exact previous bodies of the four changed functions and the previous trigger.

SET lock_timeout = '5s';
LOCK TABLE "Organization", "Session" IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Organization" WHERE "status" <> 'ACTIVE' OR "statusChangedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_ORGANIZATION_STATUS_IN_USE';
  END IF;
  IF EXISTS (SELECT 1 FROM "Session" WHERE "scope" <> 'FULL') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_RECOVERY_SESSION_EXISTS';
  END IF;
END $$;

-- Session resolution: previous hardened resolve_session (20260917140000), same signature and grant.
CREATE OR REPLACE FUNCTION resolve_session(p_hash TEXT)
RETURNS TABLE (
  id TEXT,
  "organizationId" TEXT,
  "tenantId" TEXT,
  "subjectId" TEXT,
  "identityAccountId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3)
)
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s."organizationId", s."tenantId", s."subjectId", s."identityAccountId", s."expiresAt", s."revokedAt", s."lastSeenAt"
  FROM "Session" s
  WHERE s.id = p_hash
  LIMIT 1;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_session(TEXT) FROM PUBLIC;
DROP FUNCTION luxia_session_resolve(TEXT);

-- Invitations: previous resolver and guard (20261011000000).
CREATE OR REPLACE FUNCTION luxia_invitation_resolve(p_token_hash TEXT)
RETURNS TABLE(invitation_id TEXT, organization_id TEXT, tenant_id TEXT, subject_id TEXT, invitation_role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i."id", i."organizationId", i."tenantId", i."subjectId", i."role"::TEXT
  FROM "Invitation" i
  WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND i."tokenHash" = p_token_hash
    AND i."acceptedAt" IS NULL AND i."revokedAt" IS NULL AND i."expiresAt" > (now() AT TIME ZONE 'UTC')
  LIMIT 1
$$;
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
    NEW."createdAt" := v_now;
    NEW."updatedAt" := v_now;
    NEW."expiresAt" := v_now + interval '7 days';
    RETURN NEW;
  END IF;
  IF OLD."acceptedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."subjectId" IS DISTINCT FROM OLD."subjectId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR NEW."role" IS DISTINCT FROM OLD."role"
     OR NEW."invitedBySubjectId" IS DISTINCT FROM OLD."invitedBySubjectId"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'INVITATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."acceptedAt" IS NOT NULL AND OLD."expiresAt" <= v_now THEN
    RAISE EXCEPTION 'INVITATION_EXPIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Domains: previous guard (20261011000000) and its trigger on UPDATE OR DELETE only.
CREATE OR REPLACE FUNCTION luxia_organization_domain_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ORGANIZATION_DOMAIN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."domain" IS DISTINCT FROM OLD."domain"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ORGANIZATION_DOMAIN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER organization_domain_guard ON "OrganizationDomain";
CREATE TRIGGER organization_domain_guard BEFORE UPDATE OR DELETE ON "OrganizationDomain"
FOR EACH ROW EXECUTE FUNCTION luxia_organization_domain_guard();

-- New guards, helper, constraint, columns and types.
DROP TRIGGER session_guard ON "Session";
DROP FUNCTION luxia_session_guard();
DROP TRIGGER organization_status_effects ON "Organization";
DROP FUNCTION luxia_organization_status_effects();
DROP TRIGGER organization_status_guard ON "Organization";
DROP FUNCTION luxia_organization_status_guard();
DROP FUNCTION luxia_organization_lock_active(TEXT);
ALTER TABLE "Session" DROP CONSTRAINT "Session_recovery_lifetime";
ALTER TABLE "Session" DROP COLUMN "scope";
ALTER TABLE "Organization" DROP COLUMN "status", DROP COLUMN "statusChangedAt";
DROP TYPE "SessionScope";
DROP TYPE "OrganizationStatus";

-- Prisma history, so that the migration can be applied again.
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261011180000_organization_status_session_scope';
  END IF;
END $$;

RESET lock_timeout;
