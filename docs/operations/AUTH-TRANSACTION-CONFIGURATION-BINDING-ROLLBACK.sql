-- Rollback of 20261016100000_auth_transaction_configuration_binding (F4, slice S4). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Lossless only while no transaction carries a configuration hash (no generic OIDC sign-in has started); it refuses
-- otherwise, and a forward fix is then the only option. Run it before the S2 rollback, never after.
SET lock_timeout = '5s';
LOCK TABLE "AuthTransaction" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "AuthTransaction" WHERE "expectedConfigurationHash" IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_CONFIGURATION_BINDING_IN_USE';
  END IF;
END $$;
ALTER TABLE "AuthTransaction" DROP CONSTRAINT "AuthTransaction_expectedConfigurationHash";
ALTER TABLE "AuthTransaction" DROP COLUMN "expectedConfigurationHash";
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016100000_auth_transaction_configuration_binding';
  END IF;
END $$;
RESET lock_timeout;
