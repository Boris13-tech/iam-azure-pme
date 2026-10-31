-- CI only: the runtime role of the ephemeral test database, with the same grants Production gives app_user.
-- Used by both CI jobs (.github/workflows/ci.yml). Never run against Production.
DO
$do$
BEGIN
   IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_roles
      WHERE rolname = 'app_user') THEN
      CREATE ROLE app_user LOGIN PASSWORD 'app_password'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
   END IF;
END
$do$;

GRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user;
-- app_user is created after migrations in this ephemeral CI database.
GRANT EXECUTE ON FUNCTION public.luxia_sod_scope_contains(TEXT,TEXT,TEXT,TEXT) TO app_user;
-- Customer Self-Onboarding v1: same grants as the migration gives app_user in Production.
GRANT EXECUTE ON FUNCTION public.luxia_rate_limit_hit(TEXT,TEXT,INTEGER,INTEGER) TO app_user;
GRANT EXECUTE ON FUNCTION public.luxia_signup_reserve(TEXT,TEXT,JSONB,INTEGER) TO app_user;
GRANT EXECUTE ON FUNCTION public.luxia_signup_consume(TEXT,TEXT) TO app_user;
GRANT EXECUTE ON FUNCTION public.luxia_invitation_resolve(TEXT) TO app_user;
GRANT EXECUTE ON FUNCTION public.luxia_login_decoy(TEXT) TO app_user;
-- First Admin / Break-glass v1: same grants as the migration gives app_user in Production.
GRANT EXECUTE ON FUNCTION public.luxia_organization_lock_active(TEXT) TO app_user;
GRANT EXECUTE ON FUNCTION public.luxia_session_resolve(TEXT) TO app_user;
-- Sovereign providers F2: same grant as the migration gives app_user in Production.
GRANT EXECUTE ON FUNCTION public.luxia_provider_connection_lock_active(TEXT,TEXT) TO app_user;
-- R3: the daily retention job (same grant as the migration gives app_user in Production).
GRANT EXECUTE ON FUNCTION public.luxia_retention_purge_transactions(INTEGER,BOOLEAN) TO app_user;
GRANT CONNECT ON DATABASE luxia_db TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
-- Mirror the Production grants of Customer Self-Onboarding v1 (migration DO block).
REVOKE ALL ON "SignupCode", "RateLimitBucket", "RateLimitConfig" FROM app_user;
REVOKE ALL ON "OrganizationDomain", "Invitation" FROM app_user;
GRANT SELECT, INSERT, UPDATE ON "OrganizationDomain", "Invitation" TO app_user;
-- T0: the journal and the sign-in evidence are append-only (same as the migration gives app_user in Production).
REVOKE UPDATE, DELETE, TRUNCATE ON "CanonicalAdminAuditEvent", "AuthenticationEvidence" FROM app_user;
-- F2: a provider connection is never deleted (same as the migration gives app_user in Production).
REVOKE DELETE, TRUNCATE ON "ProviderConnection" FROM app_user;
-- R3: retention run records are owner-only (same as the migration gives app_user in Production).
REVOKE ALL ON "RetentionRun" FROM app_user;
REVOKE ALL ON SEQUENCE "RetentionRun_id_seq" FROM app_user;
-- F3: secret references are revoked, never deleted (same as the migration gives app_user in Production).
REVOKE DELETE, TRUNCATE ON "ProviderSecretReference" FROM app_user;
