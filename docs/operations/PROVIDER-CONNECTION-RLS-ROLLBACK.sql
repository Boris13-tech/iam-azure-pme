-- Rollback of 20261014100000_provider_connection_rls (F2 M2). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Lossless: no data is involved. Restores the previous state exactly (no policy, row-level security neither
-- enabled nor forced on "ProviderConnection"). M1 (status, guards, kill switch) is untouched.
SET lock_timeout = '5s';
LOCK TABLE "ProviderConnection" IN ACCESS EXCLUSIVE MODE;
DROP POLICY "provider_connection_organization_isolation" ON "ProviderConnection";
ALTER TABLE "ProviderConnection" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ProviderConnection" DISABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261014100000_provider_connection_rls';
  END IF;
END $$;
RESET lock_timeout;
