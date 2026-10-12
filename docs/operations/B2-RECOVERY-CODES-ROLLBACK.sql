-- Rollback of 20261012090000_recovery_codes_b2 (B2 design, section 10).
-- Run as the owner, in ONE transaction:  psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Deploy the B3 application (8aec711) first: it never issues or consumes recovery codes and refuses
-- RECOVERY sessions at resolution.
-- Safe after codes were issued: no code that was ever invalidated can become usable again.
-- A code still usable at rollback time stays as it is; if the migration is applied again later, its
-- backfill revokes it (the batch is lost with the column) and the person generates a new batch.

SET lock_timeout = '5s';
LOCK TABLE "LocalRecoveryCode", "Session" IN ACCESS EXCLUSIVE MODE;

-- 1. The guard and the hash CHECK go first: step 2 writes frozen rows, and rows written before B2
--    (another hash encoding, kept by NOT VALID) would fail the CHECK on any update.
DROP TRIGGER recovery_code_guard ON "LocalRecoveryCode";
ALTER TABLE "LocalRecoveryCode" DROP CONSTRAINT "LocalRecoveryCode_hash_format";

-- 2. No resurrection: a revoked code that was never used becomes "used" before revokedAt disappears.
UPDATE "LocalRecoveryCode" SET "usedAt" = "revokedAt" WHERE "revokedAt" IS NOT NULL AND "usedAt" IS NULL;

-- 3. Recovery sessions still open are closed (the session guard allows NULL to a timestamp, once).
UPDATE "Session" SET "revokedAt" = (now() AT TIME ZONE 'UTC') WHERE "scope" = 'RECOVERY' AND "revokedAt" IS NULL;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "LocalRecoveryCode" WHERE "revokedAt" IS NOT NULL AND "usedAt" IS NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_ASSERTION_REVOKED_CODE_WOULD_RESURRECT';
  END IF;
  IF EXISTS (SELECT 1 FROM "Session" WHERE "scope" = 'RECOVERY' AND "revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_ASSERTION_RECOVERY_SESSION_OPEN';
  END IF;
END $$;

-- 4. Schema objects of the migration, then its history row.
DROP FUNCTION luxia_recovery_code_guard();
DROP INDEX "LocalRecoveryCode_usable_idx";
ALTER TABLE "LocalRecoveryCode" DROP COLUMN "batchId", DROP COLUMN "revokedAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261012090000_recovery_codes_b2';

RESET lock_timeout;
