-- Rollback of 20261112130000_retention_hold_register. Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Possible only while the register has never been used: a hold, even released, leaves its history, the operator
-- journal of holds, and that history is never dropped. Once a hold has been recorded, a defect is fixed forward.
-- Restores the guard, R4, R6 and the status exactly as 20261025120000 and 20261112100000 left them, drops the register,
-- its history and its functions, and removes the migration's line in Prisma's history, so that the next
-- `prisma migrate deploy` applies it again. Deploy the previous release of the application first.
SET lock_timeout = '5s';
-- Only the last applied migration can be rolled back: a later one may depend on what this removes or restores.
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" > '20261112130000_retention_hold_register' AND "rolled_back_at" IS NULL) THEN
      RAISE EXCEPTION 'ROLLBACK_NOT_LATEST_MIGRATION' USING ERRCODE = '55000';
    END IF;
  END IF;
END $$;
LOCK TABLE "RetentionHold", "RetentionHoldEvent" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "RetentionHoldEvent") OR EXISTS (SELECT 1 FROM "RetentionHold") THEN
    RAISE EXCEPTION 'ROLLBACK_HOLD_REGISTER_IN_USE' USING ERRCODE = '55000';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION luxia_invitation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');
BEGIN
  -- R4: the data-based exception, the DELETE of an invitation finished (accepted, revoked or expired) for more than
  -- 30 days (PROPOSED period). createdAt and expiresAt are set by this guard and never change; acceptedAt and
  -- revokedAt come from the application, so a backdated one cannot make a row created less than 30 days ago go.
  IF TG_OP = 'DELETE' AND LEAST(OLD."acceptedAt", OLD."revokedAt", OLD."expiresAt") < v_now - interval '30 days'
     AND OLD."createdAt" < v_now - interval '30 days' THEN
    RETURN OLD;
  END IF;
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
  -- R4: the moment an invitation ends is the database's clock, never the caller's. Without this, a role that may
  -- revoke could backdate revokedAt and make a row finished less than 30 days ago eligible for the purge.
  IF NEW."acceptedAt" IS NOT NULL AND OLD."acceptedAt" IS NULL THEN NEW."acceptedAt" := v_now; END IF;
  IF NEW."revokedAt" IS NOT NULL AND OLD."revokedAt" IS NULL THEN NEW."revokedAt" := v_now; END IF;
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

CREATE OR REPLACE FUNCTION luxia_retention_purge_invitations(p_batch integer, p_enforce boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC'); -- the guard's v_now: same expression, same type
  v_invitations integer;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 5000 OR p_enforce IS NULL THEN
    RAISE EXCEPTION 'RETENTION_ARGUMENT_OUT_OF_RANGE' USING ERRCODE = '22023';
  END IF;
  -- Row-level security is forced on Invitation: an owner without BYPASSRLS would see no row.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'RETENTION_OWNER_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  -- Dry run only for the runtime role, as for R6, until the hold register exists and a reviewed migration lifts this:
  -- a held organization must be skipped before anything is deleted (Beta scope, section 4.3; Codex, review of #138).
  -- The owner in its own session may enforce: a definer call changes current_user, never session_user.
  IF p_enforce AND session_user <> current_user THEN
    RAISE EXCEPTION 'RETENTION_R4_ENFORCE_NOT_ACTIVATED' USING ERRCODE = '42501';
  END IF;
  -- One run at a time.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('luxia-retention-purge-invitations', 0)) THEN
    RAISE EXCEPTION 'RETENTION_ALREADY_RUNNING' USING ERRCODE = '55P03';
  END IF;
  IF p_enforce THEN
    DELETE FROM "Invitation" WHERE "id" IN (
      SELECT "id" FROM "Invitation"
      WHERE LEAST("acceptedAt", "revokedAt", "expiresAt") < v_now - interval '30 days'
        AND "createdAt" < v_now - interval '30 days'
      ORDER BY "createdAt", "id" LIMIT p_batch FOR UPDATE SKIP LOCKED);
    GET DIAGNOSTICS v_invitations = ROW_COUNT;
  ELSE
    SELECT count(*) INTO v_invitations FROM (
      SELECT 1 FROM "Invitation"
      WHERE LEAST("acceptedAt", "revokedAt", "expiresAt") < v_now - interval '30 days'
        AND "createdAt" < v_now - interval '30 days'
      LIMIT p_batch) i;
  END IF;
  -- One run record per call, like R3 (owner-only table, counts only).
  INSERT INTO "RetentionRun" ("enforced", "counts") VALUES (p_enforce, jsonb_build_object('mechanism', 'R4', 'invitations', v_invitations));
  RETURN jsonb_build_object('invitations', v_invitations, 'enforced', p_enforce);
END $$;

CREATE OR REPLACE FUNCTION luxia_retention_pseudonymize_retired(p_batch integer, p_enforce boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_cutoff TIMESTAMP(3) := (now() AT TIME ZONE 'UTC') - interval '30 days';
  v_ids TEXT[];
  v_names integer;
  v_principals integer;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 5000 OR p_enforce IS NULL THEN
    RAISE EXCEPTION 'RETENTION_ARGUMENT_OUT_OF_RANGE' USING ERRCODE = '22023';
  END IF;
  -- Row-level security is forced on Subject, IdentityAccount and LocalIdentity: an owner without BYPASSRLS would see no row.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'RETENTION_OWNER_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  -- Dry run only for the runtime role, until #148 is closed and a reviewed migration lifts this. The owner in its own
  -- session may enforce: a definer call changes current_user, never session_user.
  IF p_enforce AND session_user <> current_user THEN
    RAISE EXCEPTION 'RETENTION_R6_ENFORCE_NOT_ACTIVATED' USING ERRCODE = '42501';
  END IF;
  -- One run at a time.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('luxia-retention-pseudonymize-retired', 0)) THEN
    RAISE EXCEPTION 'RETENTION_ALREADY_RUNNING' USING ERRCODE = '55P03';
  END IF;
  IF p_enforce THEN
    SELECT coalesce(array_agg(c."id"), ARRAY[]::TEXT[]) INTO v_ids FROM (
      SELECT s."id" FROM "Subject" s
      WHERE s."type" = 'HUMAN' AND s."lifecycleState" = 'RETIRED' AND s."lifecycleChangedAt" < v_cutoff
        AND (s."name" IS DISTINCT FROM 'Ancien membre ' || left(encode(sha256(convert_to(s."id", 'UTF8')), 'hex'), 8)
          OR EXISTS (SELECT 1 FROM "IdentityAccount" a JOIN "LocalIdentity" l
                       ON l."organizationId" = a."organizationId" AND l."tenantId" = a."tenantId" AND l."identityAccountId" = a."id"
                     WHERE a."organizationId" = s."organizationId" AND a."tenantId" = s."tenantId" AND a."subjectId" = s."id"
                       AND l."principalName" IS DISTINCT FROM 'ANCIEN-MEMBRE-' || encode(sha256(convert_to(l."id", 'UTF8')), 'hex')))
      ORDER BY s."lifecycleChangedAt", s."id" LIMIT p_batch FOR UPDATE OF s SKIP LOCKED) c;
    UPDATE "Subject" s SET "name" = 'Ancien membre ' || left(encode(sha256(convert_to(s."id", 'UTF8')), 'hex'), 8)
    WHERE s."id" = ANY (v_ids)
      AND s."name" IS DISTINCT FROM 'Ancien membre ' || left(encode(sha256(convert_to(s."id", 'UTF8')), 'hex'), 8);
    GET DIAGNOSTICS v_names = ROW_COUNT;
    UPDATE "LocalIdentity" l SET "principalName" = 'ANCIEN-MEMBRE-' || encode(sha256(convert_to(l."id", 'UTF8')), 'hex')
    FROM "IdentityAccount" a
    WHERE l."organizationId" = a."organizationId" AND l."tenantId" = a."tenantId" AND l."identityAccountId" = a."id"
      AND a."subjectId" = ANY (v_ids)
      AND l."principalName" IS DISTINCT FROM 'ANCIEN-MEMBRE-' || encode(sha256(convert_to(l."id", 'UTF8')), 'hex');
    GET DIAGNOSTICS v_principals = ROW_COUNT;
  ELSE
    SELECT coalesce(array_agg(c."id"), ARRAY[]::TEXT[]) INTO v_ids FROM (
      SELECT s."id" FROM "Subject" s
      WHERE s."type" = 'HUMAN' AND s."lifecycleState" = 'RETIRED' AND s."lifecycleChangedAt" < v_cutoff
        AND (s."name" IS DISTINCT FROM 'Ancien membre ' || left(encode(sha256(convert_to(s."id", 'UTF8')), 'hex'), 8)
          OR EXISTS (SELECT 1 FROM "IdentityAccount" a JOIN "LocalIdentity" l
                       ON l."organizationId" = a."organizationId" AND l."tenantId" = a."tenantId" AND l."identityAccountId" = a."id"
                     WHERE a."organizationId" = s."organizationId" AND a."tenantId" = s."tenantId" AND a."subjectId" = s."id"
                       AND l."principalName" IS DISTINCT FROM 'ANCIEN-MEMBRE-' || encode(sha256(convert_to(l."id", 'UTF8')), 'hex')))
      ORDER BY s."lifecycleChangedAt", s."id" LIMIT p_batch) c;
    SELECT count(*) INTO v_names FROM "Subject" s
    WHERE s."id" = ANY (v_ids)
      AND s."name" IS DISTINCT FROM 'Ancien membre ' || left(encode(sha256(convert_to(s."id", 'UTF8')), 'hex'), 8);
    SELECT count(*) INTO v_principals FROM "LocalIdentity" l JOIN "IdentityAccount" a
      ON l."organizationId" = a."organizationId" AND l."tenantId" = a."tenantId" AND l."identityAccountId" = a."id"
    WHERE a."subjectId" = ANY (v_ids)
      AND l."principalName" IS DISTINCT FROM 'ANCIEN-MEMBRE-' || encode(sha256(convert_to(l."id", 'UTF8')), 'hex');
  END IF;
  -- One run record per call, like R3 (owner-only table, counts only).
  INSERT INTO "RetentionRun" ("enforced", "counts") VALUES (p_enforce, jsonb_build_object('mechanism', 'R6',
    'subjects', cardinality(v_ids), 'displayNames', v_names, 'principalNames', v_principals));
  RETURN jsonb_build_object('subjects', cardinality(v_ids), 'displayNames', v_names, 'principalNames', v_principals, 'enforced', p_enforce);
END $$;

CREATE OR REPLACE FUNCTION luxia_retention_status() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');
  v_status jsonb;
BEGIN
  -- Row-level security is forced on the tables read here: an owner without BYPASSRLS would see no row.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'RETENTION_OWNER_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    -- R3: expired for more than 7 days; overdue after 7 + 3 days.
    'R3', (SELECT jsonb_build_object('eligible', count(*), 'overdue', count(*) FILTER (WHERE r.due < v_now - interval '10 days'),
             'oldestHours', coalesce(floor(extract(epoch FROM v_now - min(r.due)) / 3600)::integer, 0))
           FROM (SELECT "expiresAt" AS due FROM "LocalAuthChallenge" WHERE "expiresAt" < v_now - interval '7 days'
                 UNION ALL
                 SELECT "expiresAt" FROM "AuthTransaction" WHERE "expiresAt" < v_now - interval '7 days') r),
    -- R4: finished (accepted, revoked or expired) and created more than 30 days ago; overdue after 30 + 3 days.
    'R4', (SELECT jsonb_build_object('eligible', count(*), 'overdue', count(*) FILTER (WHERE r.due < v_now - interval '33 days'),
             'oldestHours', coalesce(floor(extract(epoch FROM v_now - min(r.due)) / 3600)::integer, 0))
           FROM (SELECT GREATEST(LEAST("acceptedAt", "revokedAt", "expiresAt"), "createdAt") AS due FROM "Invitation"
                 WHERE LEAST("acceptedAt", "revokedAt", "expiresAt") < v_now - interval '30 days'
                   AND "createdAt" < v_now - interval '30 days') r),
    -- R6: a person retired for more than 30 days whose names are not yet pseudonyms; overdue after 30 + 3 days.
    'R6', (SELECT jsonb_build_object('eligible', count(*), 'overdue', count(*) FILTER (WHERE r.due < v_now - interval '33 days'),
             'oldestHours', coalesce(floor(extract(epoch FROM v_now - min(r.due)) / 3600)::integer, 0))
           FROM (SELECT s."lifecycleChangedAt" AS due FROM "Subject" s
                 WHERE s."type" = 'HUMAN' AND s."lifecycleState" = 'RETIRED' AND s."lifecycleChangedAt" < v_now - interval '30 days'
                   AND (s."name" IS DISTINCT FROM 'Ancien membre ' || left(encode(sha256(convert_to(s."id", 'UTF8')), 'hex'), 8)
                     OR EXISTS (SELECT 1 FROM "IdentityAccount" a JOIN "LocalIdentity" l
                                  ON l."organizationId" = a."organizationId" AND l."tenantId" = a."tenantId" AND l."identityAccountId" = a."id"
                                WHERE a."organizationId" = s."organizationId" AND a."tenantId" = s."tenantId" AND a."subjectId" = s."id"
                                  AND l."principalName" IS DISTINCT FROM 'ANCIEN-MEMBRE-' || encode(sha256(convert_to(l."id", 'UTF8')), 'hex')))) r)
  ) INTO v_status;
  INSERT INTO "RetentionRun" ("enforced", "counts") VALUES (false, jsonb_build_object('mechanism', 'status') || v_status);
  RETURN v_status;
END $$;

DROP FUNCTION luxia_retention_hold_place(text, text, date);
DROP FUNCTION luxia_retention_hold_renew(text, text, date);
DROP FUNCTION luxia_retention_hold_release(text, text);
DROP FUNCTION luxia_retention_held(text);
DROP TABLE "RetentionHoldEvent";
DROP TABLE "RetentionHold";
DROP FUNCTION luxia_retention_hold_event_guard();
DROP FUNCTION luxia_retention_hold_guard();
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261112130000_retention_hold_register';
  END IF;
END $$;
RESET lock_timeout;
