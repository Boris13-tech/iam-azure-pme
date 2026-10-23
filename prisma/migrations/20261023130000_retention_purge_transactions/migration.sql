-- R3 (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md): expired sign-in challenges and Microsoft
-- sign-in transactions are deleted 7 days after they expire. They have no audit value; a transaction
-- holds a PKCE verifier and a nonce. The period is code: changing it is a reviewed migration.
--
-- One entry point for the runtime (the daily job): fixed predicates, bounded batches, a dry-run mode,
-- and one RetentionRun row per call with the counts only. Owner-only table; no row content is copied.

CREATE TABLE "RetentionRun" (
  "id"       BIGSERIAL PRIMARY KEY,
  "ranAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "enforced" BOOLEAN NOT NULL,
  "counts"   JSONB NOT NULL,
  CONSTRAINT "RetentionRun_counts" CHECK (jsonb_typeof("counts") = 'object')
);
CREATE INDEX "RetentionRun_ranAt_idx" ON "RetentionRun" ("ranAt");
ALTER TABLE "RetentionRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RetentionRun" FORCE ROW LEVEL SECURITY;

-- p_enforce false: counts what would go, deletes nothing. Returns the counts, also recorded.
CREATE FUNCTION luxia_retention_purge_transactions(p_batch integer, p_enforce boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_cutoff  TIMESTAMP(3) := (now() AT TIME ZONE 'UTC') - interval '7 days';
  v_challenges integer;
  v_transactions integer;
  v_runs integer;
  v_counts jsonb;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 5000 OR p_enforce IS NULL THEN
    RAISE EXCEPTION 'RETENTION_ARGUMENT_OUT_OF_RANGE' USING ERRCODE = '22023';
  END IF;
  -- Row-level security is forced on LocalAuthChallenge: an owner without BYPASSRLS would see no row.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'RETENTION_OWNER_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  -- One run at a time.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('luxia-retention-purge-transactions', 0)) THEN
    RAISE EXCEPTION 'RETENTION_ALREADY_RUNNING' USING ERRCODE = '55P03';
  END IF;
  IF p_enforce THEN
    DELETE FROM "LocalAuthChallenge" WHERE "id" IN (
      SELECT "id" FROM "LocalAuthChallenge" WHERE "expiresAt" < v_cutoff ORDER BY "expiresAt" LIMIT p_batch FOR UPDATE SKIP LOCKED);
    GET DIAGNOSTICS v_challenges = ROW_COUNT;
    DELETE FROM "AuthTransaction" WHERE "id" IN (
      SELECT "id" FROM "AuthTransaction" WHERE "expiresAt" < v_cutoff ORDER BY "expiresAt" LIMIT p_batch FOR UPDATE SKIP LOCKED);
    GET DIAGNOSTICS v_transactions = ROW_COUNT;
    DELETE FROM "RetentionRun" WHERE "ranAt" < now() - interval '400 days';
    GET DIAGNOSTICS v_runs = ROW_COUNT;
  ELSE
    SELECT count(*) INTO v_challenges FROM (SELECT 1 FROM "LocalAuthChallenge" WHERE "expiresAt" < v_cutoff LIMIT p_batch) c;
    SELECT count(*) INTO v_transactions FROM (SELECT 1 FROM "AuthTransaction" WHERE "expiresAt" < v_cutoff LIMIT p_batch) t;
    SELECT count(*) INTO v_runs FROM "RetentionRun" WHERE "ranAt" < now() - interval '400 days';
  END IF;
  v_counts := jsonb_build_object('localAuthChallenges', v_challenges, 'authTransactions', v_transactions, 'retentionRuns', v_runs);
  INSERT INTO "RetentionRun" ("enforced", "counts") VALUES (p_enforce, v_counts);
  RETURN v_counts || jsonb_build_object('enforced', p_enforce);
END $$;
REVOKE ALL ON FUNCTION luxia_retention_purge_transactions(integer, boolean) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON "RetentionRun" FROM app_user;
    REVOKE ALL ON SEQUENCE "RetentionRun_id_seq" FROM app_user;
    GRANT EXECUTE ON FUNCTION luxia_retention_purge_transactions(integer, boolean) TO app_user;
  END IF;
END $$;
