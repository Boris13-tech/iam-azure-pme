-- Rollback of 20261114120000_retention_worker_role (issue #150). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Gives EXECUTE on the four retention functions back to app_user and takes it away from luxia_retention, so the daily
-- job runs again through the application's own connection. The role itself is kept, its login disabled when no other database refers to it: dropping
-- it would fail while the Production secret still names it, and a role that cannot log in and holds nothing of its own
-- is inert (what PUBLIC holds, every role holds).
--
-- ORDER: this rollback first, then deploy the previous release. The deploy workflow refuses a release whose migrations
-- do not match the database, so the code cannot go first. Between the two, the job of the release still running has
-- lost its privileges and fails every run, closed, with its alert: that is expected, and lasts until the deploy.
-- R4 and R6 must not be enforcing: this puts the privilege to delete back on the role that serves web requests, which
-- is what #150 removed. If the database is restored into a new cluster later, roles do not travel with a backup:
-- scripts/backup/restore.mjs creates the roles the backup names, luxia_retention among them, NOLOGIN NOINHERIT; its
-- login and password are then the operator's again, before the daily job can connect.
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
    -- Its password stays in the Production secret: without a login, it opens nothing (Claude Opus, fourth review).
    -- But the role belongs to the whole cluster, and this rollback to one database: its login is disabled only when no
    -- other database still refers to it. Otherwise this would cut off another database's job (a restored copy, a
    -- drill's scratch database), which the rollback drills of older migrations showed by doing exactly that.
    IF NOT EXISTS (SELECT 1 FROM pg_shdepend d
        WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention')
          AND NOT (d.dbid = (SELECT oid FROM pg_database WHERE datname = current_database()))
          AND NOT (d.dbid = 0 AND d.classid = 'pg_database'::regclass AND d.objid = (SELECT oid FROM pg_database WHERE datname = current_database()))) THEN
      -- Needs the admin option on the role, which its creator holds. An owner that lacks it must not lose the whole
      -- rollback over this one step, which only tidies a role that holds nothing here any more: it is reported loudly
      -- and left to the operator (Claude Opus, sixth review of #196).
      BEGIN
        ALTER ROLE luxia_retention NOLOGIN;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE WARNING 'luxia_retention keeps its login: this owner cannot alter it. Disable it in Neon (ALTER ROLE luxia_retention NOLOGIN).';
      END;
    ELSE
      RAISE NOTICE 'luxia_retention keeps its login: another database of this cluster still refers to it';
    END IF;
  END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114120000_retention_worker_role';
  END IF;
END $$;
RESET lock_timeout;
