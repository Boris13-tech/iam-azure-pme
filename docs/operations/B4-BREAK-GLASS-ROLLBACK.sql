-- Rollback of 20261012180000_break_glass_operator_invitation (B4 design, section 13).
-- Run as the owner, in ONE transaction:  psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Deploy the previous application first (B2, fe34cf7): it never creates or honours operator invitations.
-- Safe after use: an operator invitation that is still open is revoked first, so it can never be
-- honoured under the previous rules. Accepted ones stay as history (their grants are journaled).

SET lock_timeout = '5s';
LOCK TABLE "Invitation" IN ACCESS EXCLUSIVE MODE;

-- 1. No operator invitation stays usable.
UPDATE "Invitation" SET "revokedAt" = (now() AT TIME ZONE 'UTC'), "pendingChallengeHash" = NULL, "pendingExpiresAt" = NULL
WHERE "issuedByOperatorChangeId" IS NOT NULL AND "acceptedAt" IS NULL AND "revokedAt" IS NULL;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Invitation" WHERE "issuedByOperatorChangeId" IS NOT NULL AND "acceptedAt" IS NULL AND "revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_ASSERTION_OPERATOR_INVITATION_OPEN';
  END IF;
END $$;

-- 2. The previous guard, exactly as in 20261011180000_organization_status_session_scope.
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

-- 3. The state CHECK of 20261011000000 (exactly 7 days). If operator invitations exist in history
--    (24 hours, accepted or revoked), it is restored NOT VALID: those rows are frozen by the guard
--    (an accepted or revoked invitation can never be updated), and every new row is checked.
ALTER TABLE "Invitation" DROP CONSTRAINT "Invitation_state";
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Invitation" WHERE "issuedByOperatorChangeId" IS NOT NULL) THEN
    ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_state"
      CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'
        AND ("pendingChallengeHash" IS NULL OR "pendingChallengeHash" ~ '^[0-9a-f]{64}$')
        AND NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
        AND "expiresAt" = "createdAt" + interval '7 days') NOT VALID;
  ELSE
    ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_state"
      CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'
        AND ("pendingChallengeHash" IS NULL OR "pendingChallengeHash" ~ '^[0-9a-f]{64}$')
        AND NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
        AND "expiresAt" = "createdAt" + interval '7 days');
  END IF;
END $$;

-- 4. The column and its CHECK, then the history row.
ALTER TABLE "Invitation" DROP CONSTRAINT "Invitation_operator_change_format";
ALTER TABLE "Invitation" DROP COLUMN "issuedByOperatorChangeId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261012180000_break_glass_operator_invitation';

RESET lock_timeout;
