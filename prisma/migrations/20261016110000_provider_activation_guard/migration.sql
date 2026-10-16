-- F4, slice S5 (operator decisions 2026-10-16): the database itself refuses a first activation without valid evidence.
-- Expand only: one column, two triggers and two functions; nothing the deployed application reads or writes changes.
--   * ProviderTestRun gets a monotonic order assigned by the database ("sequence", identity, never written by the
--     application); the latest run is the one with the highest sequence. Its "occurredAt" is stamped by the database
--     clock at insert, whatever the client sends.
--   * luxia_provider_activation_evidence(organization, connection) is the ONE definition of valid evidence, used by
--     the application (to plan and apply) and by the trigger below: on the connection's current configuration hash,
--     the latest DISCOVERY run PASSED within 60 minutes, the latest PROOF run PASSED within 15 minutes, made with the
--     secret version still in force, and a live OIDC_CLIENT secret reference. Freshness uses the PostgreSQL clock.
--   * provider_connection_activation_guard refuses TESTING -> ACTIVE without that evidence (any provider type: only a
--     configured generic OIDC connection can ever have it), and refuses creating an OIDC_GENERIC connection other than
--     DRAFT (so no generic connection reaches ACTIVE without evidence).
-- Prisma applies this file as one transaction. Rollback: docs/operations/PROVIDER-ACTIVATION-GUARD-ROLLBACK.sql

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Monotonic order and database clock for test runs.
-- ---------------------------------------------------------------------------
ALTER TABLE "ProviderTestRun" ADD COLUMN "sequence" BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX "ProviderTestRun_sequence_key" ON "ProviderTestRun" ("sequence");

CREATE FUNCTION luxia_provider_test_run_stamp() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW."occurredAt" := (clock_timestamp() AT TIME ZONE 'UTC');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_provider_test_run_stamp() FROM PUBLIC;
CREATE TRIGGER provider_test_run_stamp BEFORE INSERT ON "ProviderTestRun"
FOR EACH ROW EXECUTE FUNCTION luxia_provider_test_run_stamp();

-- ---------------------------------------------------------------------------
-- The one definition of activation evidence. SECURITY INVOKER: it reads with the caller's rights and row-level security
-- (app_user inside its organization's scope, or the owner); it filters by the given organization and connection.
-- reason is NULL when the evidence is valid, otherwise a stable code (also the application's refusal code).
-- ---------------------------------------------------------------------------
CREATE FUNCTION luxia_provider_activation_evidence(p_organization_id TEXT, p_connection_id TEXT)
RETURNS TABLE ("reason" TEXT, "configurationHash" TEXT, "discoveryRunId" TEXT, "proofRunId" TEXT, "proofActorSubjectId" TEXT, "secretVersion" TEXT)
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC');
  v_hash TEXT;
  v_secret TEXT;
  v_test_id TEXT;
  v_test_outcome TEXT;
  v_test_at TIMESTAMP(3);
  v_proof_id TEXT;
  v_proof_outcome TEXT;
  v_proof_at TIMESTAMP(3);
  v_proof_actor TEXT;
  v_proof_secret TEXT;
BEGIN
  SELECT c."configurationHash" INTO v_hash FROM "ProviderOidcConfiguration" c
  WHERE c."organizationId" = p_organization_id AND c."providerConnectionId" = p_connection_id;
  IF v_hash IS NULL THEN
    RETURN QUERY SELECT 'ACTIVATION_NOT_CONFIGURED'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text; RETURN;
  END IF;
  SELECT r."activeVersion" INTO v_secret FROM "ProviderSecretReference" r
  WHERE r."organizationId" = p_organization_id AND r."providerConnectionId" = p_connection_id
    AND r."purpose" = 'OIDC_CLIENT' AND r."revokedAt" IS NULL;
  IF v_secret IS NULL THEN
    RETURN QUERY SELECT 'ACTIVATION_SECRET_REQUIRED'::text, v_hash, NULL::text, NULL::text, NULL::text, NULL::text; RETURN;
  END IF;
  SELECT t."id", t."outcome", t."occurredAt" INTO v_test_id, v_test_outcome, v_test_at FROM "ProviderTestRun" t
  WHERE t."organizationId" = p_organization_id AND t."providerConnectionId" = p_connection_id
    AND t."kind" = 'DISCOVERY' AND t."configurationHash" = v_hash
  ORDER BY t."sequence" DESC LIMIT 1;
  IF v_test_id IS NULL OR v_test_outcome <> 'PASSED' OR v_test_at < v_now - interval '60 minutes' THEN
    RETURN QUERY SELECT 'ACTIVATION_TEST_REQUIRED'::text, v_hash, NULL::text, NULL::text, NULL::text, v_secret; RETURN;
  END IF;
  SELECT t."id", t."outcome", t."occurredAt", t."actorSubjectId", t."metadata" ->> 'secretVersion'
    INTO v_proof_id, v_proof_outcome, v_proof_at, v_proof_actor, v_proof_secret FROM "ProviderTestRun" t
  WHERE t."organizationId" = p_organization_id AND t."providerConnectionId" = p_connection_id
    AND t."kind" = 'PROOF' AND t."configurationHash" = v_hash
  ORDER BY t."sequence" DESC LIMIT 1;
  IF v_proof_id IS NULL OR v_proof_outcome <> 'PASSED' OR v_proof_at < v_now - interval '15 minutes' THEN
    RETURN QUERY SELECT 'ACTIVATION_PROOF_REQUIRED'::text, v_hash, v_test_id, NULL::text, NULL::text, v_secret; RETURN;
  END IF;
  IF v_proof_secret IS DISTINCT FROM v_secret THEN
    RETURN QUERY SELECT 'ACTIVATION_PROOF_SECRET_CHANGED'::text, v_hash, v_test_id, v_proof_id, v_proof_actor, v_secret; RETURN;
  END IF;
  RETURN QUERY SELECT NULL::text, v_hash, v_test_id, v_proof_id, v_proof_actor, v_secret;
END $$;
REVOKE ALL ON FUNCTION luxia_provider_activation_evidence(TEXT, TEXT) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The database's own refusal of an activation without evidence, whatever the caller.
-- ---------------------------------------------------------------------------
CREATE FUNCTION luxia_provider_connection_activation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_reason TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."providerType"::text = 'OIDC_GENERIC' AND NEW."status"::text <> 'DRAFT' THEN
      RAISE EXCEPTION 'PROVIDER_CONNECTION_ACTIVATION_EVIDENCE' USING ERRCODE = '23514', DETAIL = 'OIDC_GENERIC_STARTS_DRAFT';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status"::text = 'TESTING' AND NEW."status"::text = 'ACTIVE' THEN
    SELECT e."reason" INTO v_reason FROM luxia_provider_activation_evidence(NEW."organizationId", NEW."id") e;
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'PROVIDER_CONNECTION_ACTIVATION_EVIDENCE' USING ERRCODE = '23514', DETAIL = v_reason;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_provider_connection_activation_guard() FROM PUBLIC;
CREATE TRIGGER provider_connection_activation_guard BEFORE INSERT OR UPDATE OF "status" ON "ProviderConnection"
FOR EACH ROW EXECUTE FUNCTION luxia_provider_connection_activation_guard();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON FUNCTION luxia_provider_test_run_stamp() FROM app_user;
    REVOKE ALL ON FUNCTION luxia_provider_connection_activation_guard() FROM app_user;
    GRANT EXECUTE ON FUNCTION luxia_provider_activation_evidence(TEXT, TEXT) TO app_user;
  END IF;
END $$;

RESET lock_timeout;
