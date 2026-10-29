-- Rollback of 20261025120000_retention_invitations_pseudonymization (R4, R6). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Restores luxia_invitation_guard exactly as R7 (20261023140000_organization_erasure) left it, without the R4
-- exception, and removes the two retention entry points. Always possible. What already ran is not undone: deleted
-- invitations were finished for more than 30 days, and pseudonymized names are not kept anywhere (by design).
-- Order: this rollback first, then R7's if needed, never the reverse (R7's would restore a guard without R7's gate
-- while this migration is still recorded as applied).
SET lock_timeout = '5s';
CREATE OR REPLACE FUNCTION luxia_invitation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');
BEGIN
  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
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

DROP FUNCTION luxia_retention_purge_invitations(integer, boolean);
DROP FUNCTION luxia_retention_pseudonymize_retired(integer, boolean);
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261025120000_retention_invitations_pseudonymization';
  END IF;
END $$;
RESET lock_timeout;
