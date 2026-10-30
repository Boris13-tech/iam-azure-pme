-- R4 and R6 (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md): two steps of the daily retention job. Both
-- periods are PROPOSED (docs/legal/DATA-RETENTION-AND-DELETION.md; counsel decides). They are code, not
-- configuration: changing one is a reviewed migration.
--
-- R4: an invitation finished (accepted, revoked or expired) for more than 30 days is deleted. It holds a token hash
-- and nothing else of value; the journal keeps its events. luxia_invitation_guard gains one data-based exception,
-- placed first: the DELETE of exactly such a row. The rest of the guard is R7's body, unchanged (static test).
--
-- R6: a person (HUMAN subject) RETIRED for more than 30 days is pseudonymized. The display name becomes
-- "Ancien membre <first 8 hex of SHA-256(subject id)>"; each local sign-in name becomes
-- "ANCIEN-MEMBRE-<SHA-256(local identity id)>": unique per row, and never equal to a name the application can store
-- or look up (it lowercases every sign-in name), so the uniqueness constraint holds and nobody signs in with it.
-- Nothing else changes, in particular the journal and the sign-in evidence (design fact F-4). No guard changes:
-- Subject and LocalIdentity have none.
--
-- Two runtime entry points for the daily job, like R3: SECURITY DEFINER, pinned search_path, fixed predicates,
-- bounded batches (1 to 5000), a dry-run mode, one run at a time, counts only (no row content leaves them).

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

-- R4 entry point for the daily job. p_enforce false: counts what would go, deletes nothing. Its DELETE passes the
-- guard only through the R4 exception above (same predicate, same clock): a row the guard would refuse is never
-- selected, and if one were, the guard would fail the whole run.
CREATE FUNCTION luxia_retention_purge_invitations(p_batch integer, p_enforce boolean) RETURNS jsonb
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
  RETURN jsonb_build_object('invitations', v_invitations, 'enforced', p_enforce);
END $$;
REVOKE ALL ON FUNCTION luxia_retention_purge_invitations(integer, boolean) FROM PUBLIC;

-- R6 entry point for the daily job. p_enforce false: counts what would change, changes nothing. It writes exactly two
-- columns, Subject."name" and LocalIdentity."principalName", and only to their pseudonyms; a person whose names are
-- already pseudonyms is not selected again (a name an administrator sets back is pseudonymized on the next run).
CREATE FUNCTION luxia_retention_pseudonymize_retired(p_batch integer, p_enforce boolean) RETURNS jsonb
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
  RETURN jsonb_build_object('subjects', cardinality(v_ids), 'displayNames', v_names, 'principalNames', v_principals, 'enforced', p_enforce);
END $$;
REVOKE ALL ON FUNCTION luxia_retention_pseudonymize_retired(integer, boolean) FROM PUBLIC;

-- The runtime (the daily job) gets EXECUTE on the two entry points, nothing else: it still has no DELETE on
-- "Invitation", and the guard stays a trigger function nobody can execute.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION luxia_retention_purge_invitations(integer, boolean) TO app_user;
    GRANT EXECUTE ON FUNCTION luxia_retention_pseudonymize_retired(integer, boolean) TO app_user;
  END IF;
END $$;
