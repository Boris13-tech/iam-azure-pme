-- luxia_backup: the read-only role of the independent backup (docs/operations/INDEPENDENT-BACKUP-ARCHITECTURE.md).
-- Run it as the schema owner (the role that applies the migrations), once per database. It is idempotent.
-- It sets no password: scripts/backup/set-backup-password.mjs does that, so no secret is ever in Git.
--
-- BYPASSRLS is required, not a reflex. Every tenant table has FORCE ROW LEVEL SECURITY, and pg_dump runs with
-- row_security = off: without BYPASSRLS the dump stops on the first tenant table, and with --enable-row-security
-- it would silently export no tenant rows (proven on a non-Production branch, 2026-10-13).
-- BYPASSRLS bypasses row filters only. It grants no write privilege: the role holds SELECT only.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luxia_backup') THEN
    CREATE ROLE luxia_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT BYPASSRLS CONNECTION LIMIT 3;
  END IF;
END $$;
-- Converges an existing role. SUPERUSER and REPLICATION cannot be named by a non-superuser owner: the check below
-- proves they are off instead.
ALTER ROLE luxia_backup LOGIN NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS CONNECTION LIMIT 3;
ALTER ROLE luxia_backup SET default_transaction_read_only = on;
ALTER ROLE luxia_backup SET statement_timeout = '15min';
ALTER ROLE luxia_backup SET idle_in_transaction_session_timeout = '30min';
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO luxia_backup', current_database()); END $$;
GRANT USAGE ON SCHEMA public TO luxia_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO luxia_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO luxia_backup;
-- Tables created by later migrations (run by this same owner) are readable too. If a table ever escapes this
-- rule, pg_dump fails on it: the backup breaks loudly instead of skipping data.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO luxia_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO luxia_backup;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luxia_backup'
      AND (rolsuper OR rolreplication OR rolcreatedb OR rolcreaterole OR rolinherit OR NOT rolbypassrls OR NOT rolcanlogin))
    OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'luxia_backup') THEN
    RAISE EXCEPTION 'luxia_backup does not have the expected attributes or is a member of another role';
  END IF;
END $$;
COMMIT;
