-- Rollback of 20261112100000_retention_status. Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Removes the status function and its line in Prisma's migration history, so that the next `prisma migrate deploy`
-- applies the migration again and recreates the function (Codex, review of #138: without that line removed, the
-- history said "applied" while the function was gone, and the daily job would fail). Always possible. The run records
-- it wrote stay in RetentionRun (counts only), and are purged by R3 after 400 days like every run record.
-- Deploy the previous release of the application first: it does not call the status function.
SET lock_timeout = '5s';
DROP FUNCTION IF EXISTS luxia_retention_status();
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261112100000_retention_status';
  END IF;
END $$;
RESET lock_timeout;
