-- Sovereign Provider & Federation Layer, phase F2, M2: row-level security on ProviderConnection (design 4.7,
-- finding M3). A connection is visible and writable only inside its organization's scope (app.organization_id,
-- set by withTenantDb). Owner roles with BYPASSRLS (operator procedures, backups) and the SECURITY DEFINER
-- helpers of M1 are unaffected.
-- Apply ONLY once the application of M1 (connections read inside a tenant scope) is in Production: the earlier
-- application reads connections outside any scope at sign-in and would stop finding them.
-- Prisma applies this file as one transaction. Rollback: docs/operations/PROVIDER-CONNECTION-RLS-ROLLBACK.sql

SET lock_timeout = '5s';
LOCK TABLE "ProviderConnection" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "ProviderConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderConnection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_connection_organization_isolation" ON "ProviderConnection"
USING ("organizationId" = current_setting('app.organization_id', true))
WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

DO $$ BEGIN
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = '"ProviderConnection"'::regclass) THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_PROVIDER_CONNECTION_RLS';
  END IF;
END $$;

RESET lock_timeout;
