-- Rollback of 20261016110000_provider_activation_guard (F4, slice S5). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Lossless only while no test run exists (their database order would be lost) and no connection was activated from
-- TESTING; it refuses otherwise, and a forward fix is then the only option. Run it before the S4 and S2 rollbacks.
SET lock_timeout = '5s';
LOCK TABLE "ProviderConnection", "ProviderTestRun" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "ProviderTestRun")
     OR EXISTS (SELECT 1 FROM "ProviderConnection" WHERE "providerType"::text = 'OIDC_GENERIC' AND "status"::text NOT IN ('DRAFT', 'TESTING')) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_ACTIVATION_GUARD_IN_USE';
  END IF;
END $$;
DROP TRIGGER provider_connection_activation_guard ON "ProviderConnection";
DROP FUNCTION luxia_provider_connection_activation_guard();
DROP FUNCTION luxia_provider_activation_evidence(TEXT, TEXT);
DROP TRIGGER provider_test_run_stamp ON "ProviderTestRun";
DROP FUNCTION luxia_provider_test_run_stamp();
DROP INDEX "ProviderTestRun_sequence_key";
ALTER TABLE "ProviderTestRun" DROP COLUMN "sequence";
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016110000_provider_activation_guard';
  END IF;
END $$;
RESET lock_timeout;
