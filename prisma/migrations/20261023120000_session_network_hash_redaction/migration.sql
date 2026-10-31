-- R2 (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md): existing sessions may lose their
-- network hashes (ipHash, userAgentHash), one way only, revoked or not. Expand only: no row is
-- changed here. The redaction itself runs at the gate, after R1 stops writing new hashes.
--
-- The guard keeps every other rule of 20261011180000_organization_status_session_scope:
-- - an active session changes only lastSeenAt and one revocation;
-- - a revoked session is frozen, except that its hashes may be set to NULL;
-- - a hash can never be set, changed to another value, or restored;
-- - only the table owner in its own session may clear one: the runtime role goes through the operator's gate like anyone.

CREATE OR REPLACE FUNCTION luxia_session_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'SESSION_INVALID_INITIAL_STATE' USING ERRCODE = '23514';
    END IF;
    PERFORM luxia_organization_lock_active(NEW."organizationId");
    RETURN NEW;
  END IF;
  -- One way only: a hash stays as it was, or becomes NULL.
  IF (NEW."ipHash" IS DISTINCT FROM OLD."ipHash" AND NEW."ipHash" IS NOT NULL)
     OR (NEW."userAgentHash" IS DISTINCT FROM OLD."userAgentHash" AND NEW."userAgentHash" IS NOT NULL) THEN
    RAISE EXCEPTION 'SESSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."ipHash", NEW."userAgentHash") IS DISTINCT FROM ROW(OLD."ipHash", OLD."userAgentHash")
     AND NOT (current_user = session_user AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = TG_RELID AND r.rolname = current_user)) THEN
    RAISE EXCEPTION 'SESSION_REDACTION_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    -- A revoked session accepts the redaction and nothing else, on every column present or future.
    IF (to_jsonb(NEW) - 'ipHash' - 'userAgentHash') IS DISTINCT FROM (to_jsonb(OLD) - 'ipHash' - 'userAgentHash')
       OR ROW(NEW."ipHash", NEW."userAgentHash") IS NOT DISTINCT FROM ROW(OLD."ipHash", OLD."userAgentHash") THEN
      RAISE EXCEPTION 'SESSION_REVOKED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."id", NEW."organizationId", NEW."tenantId", NEW."subjectId", NEW."identityAccountId", NEW."recoveryEpoch",
         NEW."expiresAt", NEW."createdAt", NEW."scope")
     IS DISTINCT FROM ROW(OLD."id", OLD."organizationId", OLD."tenantId", OLD."subjectId", OLD."identityAccountId", OLD."recoveryEpoch",
         OLD."expiresAt", OLD."createdAt", OLD."scope") THEN
    RAISE EXCEPTION 'SESSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."revokedAt" IS NOT NULL AND NEW."lastSeenAt" IS DISTINCT FROM OLD."lastSeenAt" THEN
    RAISE EXCEPTION 'SESSION_REVOCATION_ONLY' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_session_guard() FROM PUBLIC;

-- The one-time redaction, in bounded batches. Owner only: the runtime role cannot call it.
-- Returns the number of sessions redacted by this call; 0 means done.
CREATE FUNCTION luxia_session_redact_network_hashes(p_batch integer) RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'REDACTION_BATCH_OUT_OF_RANGE' USING ERRCODE = '22023';
  END IF;
  -- Row-level security is forced on Session: a role without BYPASSRLS would see no row and report 0.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'REDACTION_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  UPDATE "Session" SET "ipHash" = NULL, "userAgentHash" = NULL
  WHERE "id" IN (SELECT "id" FROM "Session" WHERE "ipHash" IS NOT NULL OR "userAgentHash" IS NOT NULL
                 ORDER BY "id" LIMIT p_batch FOR UPDATE);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION luxia_session_redact_network_hashes(integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION luxia_session_redact_network_hashes(integer) FROM app_user';
  END IF;
END $$;
