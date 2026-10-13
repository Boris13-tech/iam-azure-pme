-- Rollback of 20261013090000_audit_append_only (T0, audit integrity).
-- Run as the owner, in ONE transaction:  psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- (or `prisma db execute --file <this file>`, which sends it as one script).
-- It restores the state before T0 exactly: no append-only guard on these two tables (the
-- resource-onboarding guard of 20261008040000 stays), and the application role holds UPDATE and DELETE
-- again, as it did before (it never held TRUNCATE). No data is touched, and no application change is
-- needed: no runtime code updates or deletes these rows.

SET lock_timeout = '5s';

DROP TRIGGER IF EXISTS audit_append_only ON "CanonicalAdminAuditEvent";
DROP TRIGGER IF EXISTS audit_append_only_truncate ON "CanonicalAdminAuditEvent";
DROP TRIGGER IF EXISTS evidence_append_only ON "AuthenticationEvidence";
DROP TRIGGER IF EXISTS evidence_append_only_truncate ON "AuthenticationEvidence";
DROP FUNCTION IF EXISTS luxia_audit_append_only();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT UPDATE, DELETE ON "CanonicalAdminAuditEvent", "AuthenticationEvidence" TO app_user;
  END IF;
END $$;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261013090000_audit_append_only';

RESET lock_timeout;
