-- Rollback of 20261023130000_retention_purge_transactions (R3). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Removes the purge function and the RetentionRun table (counts only, no personal data). Always
-- possible. Rows already purged are not restored: they were expired for more than 7 days.
SET lock_timeout = '5s';
DROP FUNCTION luxia_retention_purge_transactions(integer, boolean);
DROP TABLE "RetentionRun";
-- The runtime role had DELETE on these two tables before (the activation gate's broad grant).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT DELETE ON "AuthTransaction", "LocalAuthChallenge" TO app_user;
  END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023130000_retention_purge_transactions';
  END IF;
END $$;
RESET lock_timeout;
