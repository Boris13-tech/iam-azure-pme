-- First Admin / Break-glass v1, B4: the operator's emergency administrator invitation (decision D3).
-- Design (approved, D1-D7 and Q1): docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-B4-OPERATOR-DESIGN.md (section 6).
-- Expand only: one nullable column and the invitation guard extended. Rollback:
-- docs/operations/B4-BREAK-GLASS-ROLLBACK.sql
SET lock_timeout = '5s';
LOCK TABLE "Invitation" IN ACCESS EXCLUSIVE MODE;

-- The break-glass journal event (changeId "break-glass:<plan digest>") that issued the invitation.
-- NULL for every invitation an administrator creates in the product.
ALTER TABLE "Invitation" ADD COLUMN "issuedByOperatorChangeId" TEXT;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_operator_change_format"
  CHECK ("issuedByOperatorChangeId" IS NULL OR ("issuedByOperatorChangeId" ~ '^break-glass:[0-9a-f]{64}$' AND "role" = 'ADMIN'));
-- The state CHECK of 20261011000000 fixes the lifetime at exactly 7 days. Same rule, plus exactly
-- 24 hours for an operator invitation (D3). It is validated at once unless rows of an earlier apply
-- that was rolled back exist (24-hour operator invitations, accepted or revoked, frozen by the guard);
-- on a first apply there are none, and every row is checked.
ALTER TABLE "Invitation" DROP CONSTRAINT "Invitation_state";
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_state"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'
    AND ("pendingChallengeHash" IS NULL OR "pendingChallengeHash" ~ '^[0-9a-f]{64}$')
    AND NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
    AND "expiresAt" = "createdAt" + CASE WHEN "issuedByOperatorChangeId" IS NULL THEN interval '7 days' ELSE interval '24 hours' END) NOT VALID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Invitation" WHERE "expiresAt" <> "createdAt" + interval '7 days') THEN
    ALTER TABLE "Invitation" VALIDATE CONSTRAINT "Invitation_state";
  END IF;
END $$;

-- Same rules as 20261011180000 for every invitation, plus, for an operator invitation (D3):
--   * only the operator role (BYPASSRLS) can create one: the application never can;
--   * it lives 24 hours at most (set here, client values ignored);
--   * its link is honoured only while its break-glass event exists in the same organization, for
--     this very invitation: the authority comes from that event alone, never from the inviter.
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
REVOKE ALL ON FUNCTION luxia_invitation_guard() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Invitation" WHERE "issuedByOperatorChangeId" IS NOT NULL) THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_OPERATOR_INVITATION_EXISTS';
  END IF;
END $$;

RESET lock_timeout;
