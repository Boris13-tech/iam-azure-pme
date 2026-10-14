-- Rollback of 20261014110000_provider_secret_reference (F3). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Lossless only while the table is empty: it refuses otherwise (references then guide the running application; a forward
-- fix is the only option). The table holds references only, never a secret value.
SET lock_timeout = '5s';
LOCK TABLE "ProviderSecretReference" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "ProviderSecretReference") THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_SECRET_REFERENCES_IN_USE';
  END IF;
END $$;
DROP TABLE "ProviderSecretReference";
DROP FUNCTION luxia_provider_secret_reference_guard();
DROP TYPE "ProviderSecretPurpose";
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261014110000_provider_secret_reference';
  END IF;
END $$;
RESET lock_timeout;
