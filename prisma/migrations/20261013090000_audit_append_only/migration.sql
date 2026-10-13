-- T0, audit integrity: the administrative journal (CanonicalAdminAuditEvent) and the sign-in evidence
-- (AuthenticationEvidence) become append-only for the application and for ordinary operator paths.
-- Design: docs/architecture/LUXIA-OPERATOR-TRANSPARENCY.md (section 5, T0). Rollback:
-- docs/operations/T0-AUDIT-APPEND-ONLY-ROLLBACK.sql
--
-- What it guarantees: no UPDATE, DELETE or TRUNCATE of these rows by any ordinary statement, whatever the
-- role, including the table owner the LUXIA operator uses; and the application role loses those rights.
-- What it does not: a privileged database owner can still disable or drop the guard (a reviewed
-- migration, visible in the repository). This is append-only, not cryptographic immutability, which
-- belongs to Trust Ledger. No data changes; the existing resource-onboarding guard stays.
SET lock_timeout = '5s';

CREATE FUNCTION luxia_audit_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY' USING ERRCODE = '23514',
    DETAIL = format('%s on %s is not allowed: the audit trail is append-only', TG_OP, TG_TABLE_NAME);
END $$;
REVOKE ALL ON FUNCTION luxia_audit_append_only() FROM PUBLIC;

CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON "CanonicalAdminAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION luxia_audit_append_only();
CREATE TRIGGER audit_append_only_truncate BEFORE TRUNCATE ON "CanonicalAdminAuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION luxia_audit_append_only();
CREATE TRIGGER evidence_append_only BEFORE UPDATE OR DELETE ON "AuthenticationEvidence"
  FOR EACH ROW EXECUTE FUNCTION luxia_audit_append_only();
CREATE TRIGGER evidence_append_only_truncate BEFORE TRUNCATE ON "AuthenticationEvidence"
  FOR EACH STATEMENT EXECUTE FUNCTION luxia_audit_append_only();

-- The application role keeps SELECT and INSERT only (forced row-level security unchanged).
REVOKE UPDATE, DELETE, TRUNCATE ON "CanonicalAdminAuditEvent", "AuthenticationEvidence" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "CanonicalAdminAuditEvent", "AuthenticationEvidence" FROM app_user;
  END IF;
END $$;

RESET lock_timeout;
