-- D8.2 (docs/engineering/PRIVATE-BETA-SCOPE.md, section 4.3): the hold register. A legal obligation or claim, or the
-- customer's documented instruction, can require keeping an organization's data: a hold. It takes precedence over
-- every deletion path.
--
-- RetentionHold: one row per organization under an active hold, with a basis reference (an identifier of the private
-- record, never free text) and a review date. Its foreign key to Organization is RESTRICT: while a hold is active the
-- organization cannot be erased (R7 fails: its completeness check finds this row, and the organization row cannot go).
-- RetentionHoldEvent: append-only history of PLACE, RENEW and RELEASE. Its column is heldOrganizationId, not
-- organizationId, on purpose: the proof that a hold was released before an erasure outlives the erasure (R7's
-- completeness check looks at organizationId columns only).
-- A hold ends only by a documented release (luxia_retention_hold_release). A review date that passes never releases
-- it: the hold stays in effect and the daily status reports it as overdue for review.
-- Holds are written by the owner only, through the three functions below; the runtime role has no access.
-- R4, R6 and the invitation guard's R4 exception skip held organizations (luxia_retention_held); the status reports,
-- per mechanism, what holds keep. R4 and R6 stay dry runs for the runtime role: lifting that is a separate change.
SET lock_timeout = '5s';

CREATE TABLE "RetentionHold" (
  "organizationId" TEXT PRIMARY KEY REFERENCES "Organization"("id") ON DELETE RESTRICT,
  "basisReference" TEXT NOT NULL CONSTRAINT "RetentionHold_basis" CHECK ("basisReference" ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  -- The whole organization: the widest scope, so that no deletion path reaches held data through a narrower one.
  "scope"          TEXT NOT NULL DEFAULT 'ORGANIZATION' CONSTRAINT "RetentionHold_scope" CHECK ("scope" = 'ORGANIZATION'),
  "reviewDate"     DATE NOT NULL,
  "placedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "renewedAt"      TIMESTAMPTZ
);
ALTER TABLE "RetentionHold" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RetentionHold" FORCE ROW LEVEL SECURITY;

CREATE TABLE "RetentionHoldEvent" (
  "id"                 BIGSERIAL PRIMARY KEY,
  "heldOrganizationId" TEXT NOT NULL,
  "action"             TEXT NOT NULL CONSTRAINT "RetentionHoldEvent_action" CHECK ("action" IN ('PLACE', 'RENEW', 'RELEASE')),
  "basisReference"     TEXT NOT NULL CONSTRAINT "RetentionHoldEvent_basis" CHECK ("basisReference" ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  "scope"              TEXT NOT NULL DEFAULT 'ORGANIZATION' CONSTRAINT "RetentionHoldEvent_scope" CHECK ("scope" = 'ORGANIZATION'),
  "reviewDate"         DATE,
  "at"                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "RetentionHoldEvent_held_idx" ON "RetentionHoldEvent" ("heldOrganizationId", "at");
ALTER TABLE "RetentionHoldEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RetentionHoldEvent" FORCE ROW LEVEL SECURITY;

-- The history is append-only for everyone, the owner included.
CREATE FUNCTION luxia_retention_hold_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'RETENTION_HOLD_HISTORY_APPEND_ONLY' USING ERRCODE = '23514';
END $$;
REVOKE ALL ON FUNCTION luxia_retention_hold_event_guard() FROM PUBLIC;
CREATE TRIGGER "RetentionHoldEvent_append_only" BEFORE UPDATE OR DELETE ON "RetentionHoldEvent"
  FOR EACH ROW EXECUTE FUNCTION luxia_retention_hold_event_guard();
CREATE TRIGGER "RetentionHoldEvent_no_truncate" BEFORE TRUNCATE ON "RetentionHoldEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION luxia_retention_hold_event_guard();

-- The register changes through the three operator functions below, which set a transaction-local marker: a direct
-- INSERT, UPDATE or DELETE without it, the owner's included, is refused, so that no hold is placed, changed or lifted
-- without its history by mistake. TRUNCATE is always refused. This guards against mistakes, not against the owner: the
-- owner can set the marker, as it can disable a trigger. Same trust boundary as R7 (20261023140000).
CREATE FUNCTION luxia_retention_hold_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR coalesce(current_setting('luxia.retention_hold_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'RETENTION_HOLD_WRITE_THROUGH_FUNCTIONS_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION luxia_retention_hold_guard() FROM PUBLIC;
CREATE TRIGGER "RetentionHold_write_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RetentionHold"
  FOR EACH ROW EXECUTE FUNCTION luxia_retention_hold_guard();
CREATE TRIGGER "RetentionHold_no_truncate" BEFORE TRUNCATE ON "RetentionHold"
  FOR EACH STATEMENT EXECUTE FUNCTION luxia_retention_hold_guard();

-- Whether an organization is under an active hold. Not SECURITY DEFINER: its callers already run as the owner (the
-- definer purges and status, and the invitation guard, reached only by the owner's deletes). Any other caller fails:
-- no EXECUTE, and an owner that cannot see the register (row-level security is forced) is refused, never answered
-- "not held".
CREATE FUNCTION luxia_retention_held(p_organization_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'RETENTION_HOLD_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  -- A hold committed before this call must be visible to it: under REPEATABLE READ or SERIALIZABLE, the transaction
  -- would read the register as of its own start and could miss it (Codex, review of #192). READ COMMITTED only.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'RETENTION_REQUIRES_READ_COMMITTED' USING ERRCODE = '0A000';
  END IF;
  RETURN EXISTS (SELECT 1 FROM "RetentionHold" WHERE "organizationId" = p_organization_id);
END $$;
REVOKE ALL ON FUNCTION luxia_retention_held(text) FROM PUBLIC;

-- Operator functions: the owner in its own session only (not SECURITY DEFINER, no grant). Each writes the history, the
-- operator journal of holds. Review dates are UTC dates, like the status that reports them overdue.
CREATE FUNCTION luxia_retention_hold_place(p_organization_id text, p_basis text, p_review date) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'RETENTION_HOLD_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  IF p_review IS NULL OR p_review < (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'RETENTION_HOLD_REVIEW_DATE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Organization" WHERE "id" = p_organization_id) THEN
    RAISE EXCEPTION 'RETENTION_HOLD_ORGANIZATION_UNKNOWN' USING ERRCODE = '22023';
  END IF;
  -- Wait for a running R4 or R6 call to finish: once this commits, no scheduled deletion that started before the hold
  -- is still running, and every later one sees it (they run at READ COMMITTED only, and take their lock before reading).
  PERFORM pg_advisory_xact_lock(hashtextextended('luxia-retention-purge-invitations', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('luxia-retention-pseudonymize-retired', 0));
  IF EXISTS (SELECT 1 FROM "RetentionHold" WHERE "organizationId" = p_organization_id) THEN
    RAISE EXCEPTION 'RETENTION_HOLD_ALREADY_ACTIVE' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('luxia.retention_hold_write', 'on', true);
  INSERT INTO "RetentionHold" ("organizationId", "basisReference", "reviewDate") VALUES (p_organization_id, p_basis, p_review);
  PERFORM set_config('luxia.retention_hold_write', '', true);
  INSERT INTO "RetentionHoldEvent" ("heldOrganizationId", "action", "basisReference", "reviewDate") VALUES (p_organization_id, 'PLACE', p_basis, p_review);
END $$;
REVOKE ALL ON FUNCTION luxia_retention_hold_place(text, text, date) FROM PUBLIC;

CREATE FUNCTION luxia_retention_hold_renew(p_organization_id text, p_basis text, p_review date) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_rows integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'RETENTION_HOLD_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  IF p_review IS NULL OR p_review < (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'RETENTION_HOLD_REVIEW_DATE_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('luxia.retention_hold_write', 'on', true);
  UPDATE "RetentionHold" SET "reviewDate" = p_review, "basisReference" = p_basis, "renewedAt" = now()
  WHERE "organizationId" = p_organization_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('luxia.retention_hold_write', '', true);
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'RETENTION_HOLD_NOT_ACTIVE' USING ERRCODE = '22023';
  END IF;
  INSERT INTO "RetentionHoldEvent" ("heldOrganizationId", "action", "basisReference", "reviewDate") VALUES (p_organization_id, 'RENEW', p_basis, p_review);
END $$;
REVOKE ALL ON FUNCTION luxia_retention_hold_renew(text, text, date) FROM PUBLIC;

CREATE FUNCTION luxia_retention_hold_release(p_organization_id text, p_basis text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_rows integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'RETENTION_HOLD_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('luxia.retention_hold_write', 'on', true);
  DELETE FROM "RetentionHold" WHERE "organizationId" = p_organization_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('luxia.retention_hold_write', '', true);
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'RETENTION_HOLD_NOT_ACTIVE' USING ERRCODE = '22023';
  END IF;
  INSERT INTO "RetentionHoldEvent" ("heldOrganizationId", "action", "basisReference") VALUES (p_organization_id, 'RELEASE', p_basis);
END $$;
REVOKE ALL ON FUNCTION luxia_retention_hold_release(text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION luxia_invitation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');
BEGIN
  -- R4: the data-based exception, the DELETE of an invitation finished (accepted, revoked or expired) for more than
  -- 30 days (PROPOSED period). createdAt and expiresAt are set by this guard and never change; acceptedAt and
  -- revokedAt come from the application, so a backdated one cannot make a row created less than 30 days ago go.
  -- D8.2: not for a held organization. The hold check is its own statement, reached only by such a DELETE (the owner's):
  -- EXECUTE is checked when an expression is prepared, and app_user, which inserts and updates invitations, has none.
  IF TG_OP = 'DELETE' AND LEAST(OLD."acceptedAt", OLD."revokedAt", OLD."expiresAt") < v_now - interval '30 days'
     AND OLD."createdAt" < v_now - interval '30 days' THEN
    IF NOT luxia_retention_held(OLD."organizationId") THEN
      RETURN OLD;
    END IF;
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
  v_held integer;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 5000 OR p_enforce IS NULL THEN
    RAISE EXCEPTION 'RETENTION_ARGUMENT_OUT_OF_RANGE' USING ERRCODE = '22023';
  END IF;
  -- A hold committed before this call must be visible to it: under REPEATABLE READ or SERIALIZABLE, the transaction
  -- would read the register as of its own start and could miss it (Codex, review of #192). READ COMMITTED only.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'RETENTION_REQUIRES_READ_COMMITTED' USING ERRCODE = '0A000';
  END IF;
  -- Row-level security is forced on Invitation: an owner without BYPASSRLS would see no row.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'RETENTION_OWNER_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  -- Dry run only for the runtime role, as for R6, until a reviewed migration lifts this. Held organizations are skipped
  -- (Beta scope, section 4.3; hold register: 20261112130000). The owner in its own session may enforce: a definer call
  -- changes current_user, never session_user.
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
        AND NOT luxia_retention_held("organizationId")
      ORDER BY "createdAt", "id" LIMIT p_batch FOR UPDATE SKIP LOCKED);
    GET DIAGNOSTICS v_invitations = ROW_COUNT;
  ELSE
    SELECT count(*) INTO v_invitations FROM (
      SELECT 1 FROM "Invitation"
      WHERE LEAST("acceptedAt", "revokedAt", "expiresAt") < v_now - interval '30 days'
        AND "createdAt" < v_now - interval '30 days'
        AND NOT luxia_retention_held("organizationId")
      LIMIT p_batch) i;
  END IF;
  -- The skip is journaled: eligible invitations kept because their organization is held.
  SELECT count(*) INTO v_held FROM "Invitation"
  WHERE LEAST("acceptedAt", "revokedAt", "expiresAt") < v_now - interval '30 days'
    AND "createdAt" < v_now - interval '30 days'
    AND luxia_retention_held("organizationId");
  -- One run record per call, like R3 (owner-only table, counts only).
  INSERT INTO "RetentionRun" ("enforced", "counts") VALUES (p_enforce, jsonb_build_object('mechanism', 'R4', 'invitations', v_invitations, 'held', v_held));
  RETURN jsonb_build_object('invitations', v_invitations, 'enforced', p_enforce);
END $$;

CREATE OR REPLACE FUNCTION luxia_retention_pseudonymize_retired(p_batch integer, p_enforce boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_cutoff TIMESTAMP(3) := (now() AT TIME ZONE 'UTC') - interval '30 days';
  v_ids TEXT[];
  v_names integer;
  v_principals integer;
  v_held integer;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 5000 OR p_enforce IS NULL THEN
    RAISE EXCEPTION 'RETENTION_ARGUMENT_OUT_OF_RANGE' USING ERRCODE = '22023';
  END IF;
  -- A hold committed before this call must be visible to it: under REPEATABLE READ or SERIALIZABLE, the transaction
  -- would read the register as of its own start and could miss it (Codex, review of #192). READ COMMITTED only.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'RETENTION_REQUIRES_READ_COMMITTED' USING ERRCODE = '0A000';
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
        AND NOT luxia_retention_held(s."organizationId")
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
        AND NOT luxia_retention_held(s."organizationId")
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
  -- The skip is journaled: eligible people kept because their organization is held.
  SELECT count(*) INTO v_held FROM "Subject" s
  WHERE s."type" = 'HUMAN' AND s."lifecycleState" = 'RETIRED' AND s."lifecycleChangedAt" < v_cutoff
    AND luxia_retention_held(s."organizationId")
    AND (s."name" IS DISTINCT FROM 'Ancien membre ' || left(encode(sha256(convert_to(s."id", 'UTF8')), 'hex'), 8)
      OR EXISTS (SELECT 1 FROM "IdentityAccount" a JOIN "LocalIdentity" l
                   ON l."organizationId" = a."organizationId" AND l."tenantId" = a."tenantId" AND l."identityAccountId" = a."id"
                 WHERE a."organizationId" = s."organizationId" AND a."tenantId" = s."tenantId" AND a."subjectId" = s."id"
                   AND l."principalName" IS DISTINCT FROM 'ANCIEN-MEMBRE-' || encode(sha256(convert_to(l."id", 'UTF8')), 'hex')));
  -- One run record per call, like R3 (owner-only table, counts only).
  INSERT INTO "RetentionRun" ("enforced", "counts") VALUES (p_enforce, jsonb_build_object('mechanism', 'R6',
    'subjects', cardinality(v_ids), 'displayNames', v_names, 'principalNames', v_principals, 'held', v_held));
  RETURN jsonb_build_object('subjects', cardinality(v_ids), 'displayNames', v_names, 'principalNames', v_principals, 'enforced', p_enforce);
END $$;

-- The status (20261112100000) with holds: R4 and R6 count only what the purges may act on (held organizations
-- excluded) and report what holds keep ("held"); R3 has no hold (sign-in transactions, Beta scope, section 4.3).
-- "holds" reports the active holds and those past their review date ("overdueReview"): the overdue-review alert.
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
    'R4', (SELECT jsonb_build_object('eligible', count(*) FILTER (WHERE NOT r.held),
             'overdue', count(*) FILTER (WHERE NOT r.held AND r.due < v_now - interval '33 days'),
             'oldestHours', coalesce(floor(extract(epoch FROM v_now - min(r.due) FILTER (WHERE NOT r.held)) / 3600)::integer, 0),
             'held', count(*) FILTER (WHERE r.held))
           FROM (SELECT GREATEST(LEAST("acceptedAt", "revokedAt", "expiresAt"), "createdAt") AS due,
                        luxia_retention_held("organizationId") AS held
                 FROM "Invitation"
                 WHERE LEAST("acceptedAt", "revokedAt", "expiresAt") < v_now - interval '30 days'
                   AND "createdAt" < v_now - interval '30 days') r),
    -- R6: a person retired for more than 30 days whose names are not yet pseudonyms; overdue after 30 + 3 days.
    'R6', (SELECT jsonb_build_object('eligible', count(*) FILTER (WHERE NOT r.held),
             'overdue', count(*) FILTER (WHERE NOT r.held AND r.due < v_now - interval '33 days'),
             'oldestHours', coalesce(floor(extract(epoch FROM v_now - min(r.due) FILTER (WHERE NOT r.held)) / 3600)::integer, 0),
             'held', count(*) FILTER (WHERE r.held))
           FROM (SELECT s."lifecycleChangedAt" AS due, luxia_retention_held(s."organizationId") AS held FROM "Subject" s
                 WHERE s."type" = 'HUMAN' AND s."lifecycleState" = 'RETIRED' AND s."lifecycleChangedAt" < v_now - interval '30 days'
                   AND (s."name" IS DISTINCT FROM 'Ancien membre ' || left(encode(sha256(convert_to(s."id", 'UTF8')), 'hex'), 8)
                     OR EXISTS (SELECT 1 FROM "IdentityAccount" a JOIN "LocalIdentity" l
                                  ON l."organizationId" = a."organizationId" AND l."tenantId" = a."tenantId" AND l."identityAccountId" = a."id"
                                WHERE a."organizationId" = s."organizationId" AND a."tenantId" = s."tenantId" AND a."subjectId" = s."id"
                                  AND l."principalName" IS DISTINCT FROM 'ANCIEN-MEMBRE-' || encode(sha256(convert_to(l."id", 'UTF8')), 'hex')))) r),
    -- Holds: a review date that has passed never releases a hold; it is reported until the hold is renewed or released.
    'holds', (SELECT jsonb_build_object('active', count(*), 'overdueReview', count(*) FILTER (WHERE h."reviewDate" < v_now::date))
              FROM "RetentionHold" h)
  ) INTO v_status;
  INSERT INTO "RetentionRun" ("enforced", "counts") VALUES (false, jsonb_build_object('mechanism', 'status') || v_status);
  RETURN v_status;
END $$;

-- The runtime role has no access to the register, its history or its functions. In Production, the default privileges
-- would grant it the new tables and sequence: take them back.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON "RetentionHold", "RetentionHoldEvent" FROM app_user;
    REVOKE ALL ON SEQUENCE "RetentionHoldEvent_id_seq" FROM app_user;
    REVOKE ALL ON FUNCTION luxia_retention_held(text) FROM app_user;
    REVOKE ALL ON FUNCTION luxia_retention_hold_place(text, text, date) FROM app_user;
    REVOKE ALL ON FUNCTION luxia_retention_hold_renew(text, text, date) FROM app_user;
    REVOKE ALL ON FUNCTION luxia_retention_hold_release(text, text) FROM app_user;
    REVOKE ALL ON FUNCTION luxia_retention_hold_event_guard() FROM app_user;
    REVOKE ALL ON FUNCTION luxia_retention_hold_guard() FROM app_user;
  END IF;
END $$;
