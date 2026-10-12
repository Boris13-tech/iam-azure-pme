-- First Admin / Break-glass v1: Organization.status and Session.scope.
-- Design (approved, M1-M6 and A1-A5): docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-MIGRATION-DESIGN.md
-- Expand only: the application deployed before this migration keeps working unchanged.
-- Prisma applies this file as one transaction. Rollback: docs/operations/ORGANIZATION-STATUS-SESSION-SCOPE-ROLLBACK.sql

SET lock_timeout = '5s';
-- Locks first, so that the before and after checks see the same rows (short ACCESS EXCLUSIVE).
LOCK TABLE "Organization", "Session" IN ACCESS EXCLUSIVE MODE;
SELECT set_config('luxia.migration_open_sessions', (SELECT count(*) FROM "Session" WHERE "revokedAt" IS NULL)::text, true);

-- ---------------------------------------------------------------------------
-- Schema (section 2) and backfill (section 3): metadata-only defaults, no row is rewritten.
-- ---------------------------------------------------------------------------
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE "SessionScope" AS ENUM ('FULL', 'RECOVERY');

ALTER TABLE "Organization"
  ADD COLUMN "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "statusChangedAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "scope" "SessionScope" NOT NULL DEFAULT 'FULL';
-- 9.4: a recovery-only session lives 15 minutes at most.
ALTER TABLE "Session" ADD CONSTRAINT "Session_recovery_lifetime"
  CHECK ("scope" <> 'RECOVERY' OR "expiresAt" <= "createdAt" + interval '15 minutes');

-- ---------------------------------------------------------------------------
-- 4.6 Status lock helper: share-locks the organization row and refuses unless it is ACTIVE.
-- Runtime entry point (granted to app_user), so B3 can call it first in its transactions.
-- ---------------------------------------------------------------------------
CREATE FUNCTION luxia_organization_lock_active(p_organization_id TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_status "OrganizationStatus";
BEGIN
  SELECT o."status" INTO v_status FROM "Organization" o WHERE o."id" = p_organization_id FOR SHARE;
  IF v_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'ORGANIZATION_NOT_ACTIVE' USING ERRCODE = '23514';
  END IF;
END $$;
REVOKE ALL ON FUNCTION luxia_organization_lock_active(TEXT) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 4.1 Status guard: ACTIVE at creation, operator role only (M3), under the governance lock of
-- every tenant (A1), allowed transitions only, CLOSED final for the whole row (M2).
-- ---------------------------------------------------------------------------
CREATE FUNCTION luxia_organization_status_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_tenants INTEGER;
  v_unlocked INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'ORGANIZATION_STATUS_INITIAL' USING ERRCODE = '23514';
    END IF;
    NEW."statusChangedAt" := NULL;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'ORGANIZATION_CLOSED' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    NEW."statusChangedAt" := OLD."statusChangedAt";
    RETURN NEW;
  END IF;
  IF NOT coalesce((SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user), false) THEN
    RAISE EXCEPTION 'ORGANIZATION_STATUS_OPERATOR_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NOT ((OLD."status" = 'ACTIVE' AND NEW."status" IN ('SUSPENDED', 'CLOSED'))
       OR (OLD."status" = 'SUSPENDED' AND NEW."status" IN ('ACTIVE', 'CLOSED'))) THEN
    RAISE EXCEPTION 'ORGANIZATION_STATUS_TRANSITION' USING ERRCODE = '23514';
  END IF;
  -- A1: checked, never taken here (taking it after the row lock would invert the lock order).
  -- A bigint advisory key shows its high half in classid, its low half in objid, objsubid = 1.
  SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM pg_locks l
           WHERE l.locktype = 'advisory' AND l.granted AND l.pid = pg_backend_pid() AND l.objsubid = 1
             AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
             AND l.classid::bigint = ((h.k >> 32) & 4294967295) AND l.objid::bigint = (h.k & 4294967295)))
    INTO v_tenants, v_unlocked
  FROM "Tenant" t
  CROSS JOIN LATERAL (SELECT hashtextextended('resource-governance:' || NEW."id" || ':' || t."id", 0) AS k) h
  WHERE t."organizationId" = NEW."id";
  IF v_tenants = 0 OR v_unlocked > 0 THEN
    RAISE EXCEPTION 'GOVERNANCE_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  NEW."statusChangedAt" := (now() AT TIME ZONE 'UTC');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_organization_status_guard() FROM PUBLIC;
CREATE TRIGGER organization_status_guard BEFORE INSERT OR UPDATE ON "Organization"
FOR EACH ROW EXECUTE FUNCTION luxia_organization_status_guard();

-- ---------------------------------------------------------------------------
-- 4.2 Transition completeness, checked at commit (M1: the operator procedure applies the effects).
-- Runs as the role that changed the status, which 4.1 restricts to a BYPASSRLS role.
-- ---------------------------------------------------------------------------
CREATE FUNCTION luxia_organization_status_effects() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_status "OrganizationStatus";
BEGIN
  SELECT o."status" INTO v_status FROM "Organization" o WHERE o."id" = NEW."id";
  IF v_status IN ('SUSPENDED', 'CLOSED')
     AND EXISTS (SELECT 1 FROM "Session" s WHERE s."organizationId" = NEW."id" AND s."revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'ORGANIZATION_TRANSITION_INCOMPLETE_SESSIONS' USING ERRCODE = '23514';
  END IF;
  IF v_status = 'CLOSED' AND (
       EXISTS (SELECT 1 FROM "Invitation" i WHERE i."organizationId" = NEW."id" AND i."acceptedAt" IS NULL AND i."revokedAt" IS NULL)
    OR EXISTS (SELECT 1 FROM "OrganizationDomain" d WHERE d."organizationId" = NEW."id" AND d."status" IN ('PENDING', 'VERIFIED'))) THEN
    RAISE EXCEPTION 'ORGANIZATION_TRANSITION_INCOMPLETE_CLOSED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION luxia_organization_status_effects() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER organization_status_effects AFTER UPDATE OF "status" ON "Organization"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION luxia_organization_status_effects();

-- ---------------------------------------------------------------------------
-- 4.3 Sessions are append-only (M5, A3, A4): created for an ACTIVE organization, not revoked at
-- creation; afterwards only lastSeenAt (while active) and one revocation (NULL to timestamp).
-- No rule depends on clocks: a revocation is never refused for its timestamp.
-- ---------------------------------------------------------------------------
CREATE FUNCTION luxia_session_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'SESSION_INVALID_INITIAL_STATE' USING ERRCODE = '23514';
    END IF;
    PERFORM luxia_organization_lock_active(NEW."organizationId");
    RETURN NEW;
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_REVOKED_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."id", NEW."organizationId", NEW."tenantId", NEW."subjectId", NEW."identityAccountId", NEW."recoveryEpoch",
         NEW."expiresAt", NEW."createdAt", NEW."ipHash", NEW."userAgentHash", NEW."scope")
     IS DISTINCT FROM ROW(OLD."id", OLD."organizationId", OLD."tenantId", OLD."subjectId", OLD."identityAccountId", OLD."recoveryEpoch",
         OLD."expiresAt", OLD."createdAt", OLD."ipHash", OLD."userAgentHash", OLD."scope") THEN
    RAISE EXCEPTION 'SESSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."revokedAt" IS NOT NULL AND NEW."lastSeenAt" IS DISTINCT FROM OLD."lastSeenAt" THEN
    RAISE EXCEPTION 'SESSION_REVOCATION_ONLY' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_session_guard() FROM PUBLIC;
CREATE TRIGGER session_guard BEFORE INSERT OR UPDATE ON "Session"
FOR EACH ROW EXECUTE FUNCTION luxia_session_guard();

-- ---------------------------------------------------------------------------
-- 4.4 Invitations: creating, starting and accepting require an ACTIVE organization; revoking is
-- always allowed. Same rules as before otherwise.
-- ---------------------------------------------------------------------------
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
  IF NEW."acceptedAt" IS NOT NULL
     OR (NEW."pendingChallengeHash" IS NOT NULL AND NEW."pendingChallengeHash" IS DISTINCT FROM OLD."pendingChallengeHash") THEN
    PERFORM luxia_organization_lock_active(NEW."organizationId");
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_invitation_guard() FROM PUBLIC;

-- An invitation of a SUSPENDED or CLOSED organization resolves exactly like an unknown token.
CREATE OR REPLACE FUNCTION luxia_invitation_resolve(p_token_hash TEXT)
RETURNS TABLE(invitation_id TEXT, organization_id TEXT, tenant_id TEXT, subject_id TEXT, invitation_role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i."id", i."organizationId", i."tenantId", i."subjectId", i."role"::TEXT
  FROM "Invitation" i JOIN "Organization" o ON o."id" = i."organizationId"
  WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND i."tokenHash" = p_token_hash
    AND i."acceptedAt" IS NULL AND i."revokedAt" IS NULL AND i."expiresAt" > (now() AT TIME ZONE 'UTC')
    AND o."status" = 'ACTIVE'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION luxia_invitation_resolve(TEXT) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 4.5 Domains: adding or verifying requires an ACTIVE organization; LOST and EXPIRED (release)
-- are always allowed. Same immutability as before.
-- ---------------------------------------------------------------------------
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
REVOKE ALL ON FUNCTION luxia_organization_domain_guard() FROM PUBLIC;
DROP TRIGGER organization_domain_guard ON "OrganizationDomain";
CREATE TRIGGER organization_domain_guard BEFORE INSERT OR UPDATE OR DELETE ON "OrganizationDomain"
FOR EACH ROW EXECUTE FUNCTION luxia_organization_domain_guard();

-- ---------------------------------------------------------------------------
-- 5. Canonical session resolution (A2, A5). The only implementation: nothing unless the
-- organization is ACTIVE. Runtime entry point (granted to app_user). scope is returned as text.
-- ---------------------------------------------------------------------------
CREATE FUNCTION luxia_session_resolve(p_hash TEXT)
RETURNS TABLE (id TEXT, "organizationId" TEXT, "tenantId" TEXT, "subjectId" TEXT, "identityAccountId" TEXT,
  "expiresAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3), "lastSeenAt" TIMESTAMP(3), scope TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s."id", s."organizationId", s."tenantId", s."subjectId", s."identityAccountId",
         s."expiresAt", s."revokedAt", s."lastSeenAt", s."scope"::TEXT
  FROM "Session" s JOIN "Organization" o ON o."id" = s."organizationId"
  WHERE p_hash ~ '^[0-9a-f]{64}$' AND s."id" = p_hash AND o."status" = 'ACTIVE'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION luxia_session_resolve(TEXT) FROM PUBLIC;

-- resolve_session keeps its signature (and its Production grant, which comes from the activation
-- workflow): a thin wrapper of the canonical resolver, FULL sessions only, no logic of its own.
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
  SELECT r.id, r."organizationId", r."tenantId", r."subjectId", r."identityAccountId", r."expiresAt", r."revokedAt", r."lastSeenAt"
  FROM luxia_session_resolve(p_hash) r
  WHERE r.scope = 'FULL';
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_session(TEXT) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Runtime grants. In CI app_user is created after migrations (see ci.yml bootstrap).
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON FUNCTION luxia_organization_status_guard() FROM app_user;
    REVOKE ALL ON FUNCTION luxia_organization_status_effects() FROM app_user;
    REVOKE ALL ON FUNCTION luxia_session_guard() FROM app_user;
    GRANT EXECUTE ON FUNCTION luxia_organization_lock_active(TEXT) TO app_user;
    GRANT EXECUTE ON FUNCTION luxia_session_resolve(TEXT) TO app_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Post-conditions (section 3): fail the migration if the backfill is not exactly as designed.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Organization" WHERE "status" <> 'ACTIVE' OR "statusChangedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_ORGANIZATION_STATUS';
  END IF;
  IF EXISTS (SELECT 1 FROM "Session" WHERE "scope" <> 'FULL') THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_SESSION_SCOPE';
  END IF;
  IF (SELECT count(*) FROM "Session" WHERE "revokedAt" IS NULL)::text <> current_setting('luxia.migration_open_sessions') THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_OPEN_SESSIONS';
  END IF;
END $$;

RESET lock_timeout;
