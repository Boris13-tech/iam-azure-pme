-- Rollback of 20261114120000_retention_worker_role (issue #150). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Gives EXECUTE on the four retention functions back to app_user and takes it away from luxia_retention, so the daily
-- job runs again through the application's own connection. The role itself is kept: dropping it would fail while the
-- Production secret still names it, and an empty role holds nothing.
--
-- BEFORE ROLLING BACK: deploy a release whose retention job uses the application's connection again, or the job will
-- refuse every run (it has no fallback to app_user, by design). R4 and R6 must not be enforcing: this puts the
-- privilege to delete back on the role that serves web requests, which is what #150 removed.
-- Possible while it is the last applied migration; a later one may depend on it.
SET lock_timeout = '5s';
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" > '20261114120000_retention_worker_role' AND "rolled_back_at" IS NULL) THEN
      RAISE EXCEPTION 'ROLLBACK_NOT_LATEST_MIGRATION' USING ERRCODE = '55000';
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION luxia_retention_purge_transactions(integer, boolean) TO app_user;
    GRANT EXECUTE ON FUNCTION luxia_retention_purge_invitations(integer, boolean) TO app_user;
    GRANT EXECUTE ON FUNCTION luxia_retention_pseudonymize_retired(integer, boolean) TO app_user;
    GRANT EXECUTE ON FUNCTION luxia_retention_status() TO app_user;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luxia_retention') THEN
    REVOKE EXECUTE ON FUNCTION luxia_retention_purge_transactions(integer, boolean) FROM luxia_retention;
    REVOKE EXECUTE ON FUNCTION luxia_retention_purge_invitations(integer, boolean) FROM luxia_retention;
    REVOKE EXECUTE ON FUNCTION luxia_retention_pseudonymize_retired(integer, boolean) FROM luxia_retention;
    REVOKE EXECUTE ON FUNCTION luxia_retention_status() FROM luxia_retention;
    REVOKE USAGE ON SCHEMA public FROM luxia_retention;
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM luxia_retention', current_database());
  END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114120000_retention_worker_role';
  END IF;
END $$;
RESET lock_timeout;
