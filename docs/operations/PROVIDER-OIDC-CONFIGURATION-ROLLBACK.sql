-- Rollback of 20261016090000_provider_oidc_configuration (F4, slice S2). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Lossless only while nothing uses it: it refuses once a generic OIDC connection, a configuration, a test run, or a
-- LINK or ACTIVATION_PROOF transaction exists (a forward fix is then the only option).
-- PostgreSQL cannot remove an enum value, so "ProviderType" is recreated without OIDC_GENERIC, with the remaining
-- labels in their existing order; the only column of that type is "ProviderConnection"."providerType".
SET lock_timeout = '5s';
LOCK TABLE "ProviderConnection", "ProviderOidcConfiguration", "ProviderTestRun", "AuthTransaction" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "ProviderConnection" WHERE "providerType"::text = 'OIDC_GENERIC')
     OR EXISTS (SELECT 1 FROM "ProviderOidcConfiguration")
     OR EXISTS (SELECT 1 FROM "ProviderTestRun")
     OR EXISTS (SELECT 1 FROM "AuthTransaction" WHERE "purpose" <> 'SIGN_IN') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_OIDC_CONFIGURATION_IN_USE';
  END IF;
END $$;
DROP TABLE "ProviderTestRun";
DROP TABLE "ProviderOidcConfiguration";
DROP FUNCTION luxia_provider_oidc_configuration_guard();
ALTER TABLE "AuthTransaction" DROP CONSTRAINT "AuthTransaction_purpose";
ALTER TABLE "AuthTransaction" DROP COLUMN "subjectId", DROP COLUMN "purpose";
DO $$
DECLARE v_labels TEXT;
BEGIN
  SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) INTO v_labels
  FROM pg_enum e WHERE e.enumtypid = '"ProviderType"'::regtype AND e.enumlabel <> 'OIDC_GENERIC';
  ALTER TYPE "ProviderType" RENAME TO "ProviderType_f4_rollback";
  EXECUTE format('CREATE TYPE "ProviderType" AS ENUM (%s)', v_labels);
  ALTER TABLE "ProviderConnection" ALTER COLUMN "providerType" TYPE "ProviderType" USING "providerType"::text::"ProviderType";
  DROP TYPE "ProviderType_f4_rollback";
END $$;
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016090000_provider_oidc_configuration';
  END IF;
END $$;
RESET lock_timeout;
