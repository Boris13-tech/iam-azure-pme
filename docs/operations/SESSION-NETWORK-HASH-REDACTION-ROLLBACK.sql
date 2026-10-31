-- Rollback of 20261023120000_session_network_hash_redaction (R2). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Restores the session guard of 20261011180000_organization_status_session_scope and removes the
-- redaction function. Always possible: hashes already set to NULL stay NULL (the previous guard
-- accepts them; nothing restores redacted values, by design).
SET lock_timeout = '5s';
LOCK TABLE "Session" IN SHARE ROW EXCLUSIVE MODE;
DROP FUNCTION luxia_session_redact_network_hashes(integer);
CREATE OR REPLACE FUNCTION luxia_session_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023120000_session_network_hash_redaction';
  END IF;
END $$;
RESET lock_timeout;
