-- Rollback of 20261014090000_provider_connection_lifecycle (F2 M1).
-- Run as the owner, in ONE transaction:  psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Lossless only while every connection is ACTIVE and has never changed status: it refuses otherwise,
-- and the only option is then a forward fix (a quarantined connection must never silently come back).
-- Restores the previous state exactly: no status column, no type, no trigger or function of F2, and
-- app_user's DELETE privilege on "ProviderConnection" (held before M1). The application deployed before
-- F2 never reads the status, so it keeps working once this file has run.

SET lock_timeout = '5s';
LOCK TABLE "ProviderConnection", "Session" IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "ProviderConnection" WHERE "status" <> 'ACTIVE' OR "statusChangedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_CONNECTION_STATUS_IN_USE';
  END IF;
END $$;

DROP TRIGGER session_guard_provider_connection ON "Session";
DROP TRIGGER provider_connection_effects ON "ProviderConnection";
DROP TRIGGER provider_connection_guard ON "ProviderConnection";
DROP FUNCTION luxia_session_connection_guard();
DROP FUNCTION luxia_provider_connection_lock_active(TEXT, TEXT);
DROP FUNCTION luxia_provider_connection_effects();
DROP FUNCTION luxia_provider_connection_guard();

ALTER TABLE "ProviderConnection" DROP COLUMN "statusChangedAt", DROP COLUMN "status";
DROP TYPE "ProviderConnectionStatus";

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT DELETE ON "ProviderConnection" TO app_user;
  END IF;
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261014090000_provider_connection_lifecycle';
  END IF;
END $$;

RESET lock_timeout;
