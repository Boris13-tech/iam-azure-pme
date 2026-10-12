-- First Admin / Break-glass v1, B2: personal recovery codes.
-- Design (approved, R1-R6): docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-B2-RECOVERY-DESIGN.md (section 4).
-- Expand only. Rollback: docs/operations/B2-RECOVERY-CODES-ROLLBACK.sql
SET lock_timeout = '5s';
LOCK TABLE "LocalRecoveryCode" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "LocalRecoveryCode" ADD COLUMN "batchId" TEXT, ADD COLUMN "revokedAt" TIMESTAMP(3);
-- Backfill: rows written before B2 were never shown by the product. Each becomes its own batch and is
-- revoked, so it can never be used. (Production had 0 rows on 2026-10-11.)
UPDATE "LocalRecoveryCode" SET "batchId" = "id", "revokedAt" = (now() AT TIME ZONE 'UTC') WHERE "usedAt" IS NULL;
UPDATE "LocalRecoveryCode" SET "batchId" = "id" WHERE "batchId" IS NULL;
ALTER TABLE "LocalRecoveryCode" ALTER COLUMN "batchId" SET NOT NULL;
-- New rows store SHA-256 hex only (older rows used another encoding and are all revoked above).
ALTER TABLE "LocalRecoveryCode" ADD CONSTRAINT "LocalRecoveryCode_hash_format" CHECK ("codeHash" ~ '^[0-9a-f]{64}$') NOT VALID;
CREATE INDEX "LocalRecoveryCode_usable_idx" ON "LocalRecoveryCode"("organizationId", "tenantId", "identityAccountId")
  WHERE "usedAt" IS NULL AND "revokedAt" IS NULL;

-- Guard: created for an ACTIVE organization, unused and unrevoked, at most 10 usable codes per account
-- (the count is taken under the account's local identity row lock);
-- afterwards only usedAt or revokedAt, NULL to a timestamp, once, one of them; a used or revoked code is
-- frozen; never deleted. No rule depends on clocks.
CREATE FUNCTION luxia_recovery_code_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_usable INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RECOVERY_CODE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."usedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."batchId" IS NULL THEN
      RAISE EXCEPTION 'RECOVERY_CODE_INVALID_INITIAL_STATE' USING ERRCODE = '23514';
    END IF;
    PERFORM luxia_organization_lock_active(NEW."organizationId");
    -- Concurrent batches of one account are serialized on its local identity row, so the count
    -- below sees every committed code.
    PERFORM 1 FROM "LocalIdentity"
      WHERE "organizationId" = NEW."organizationId" AND "tenantId" = NEW."tenantId" AND "identityAccountId" = NEW."identityAccountId"
      FOR NO KEY UPDATE;
    SELECT count(*) INTO v_usable FROM "LocalRecoveryCode"
      WHERE "organizationId" = NEW."organizationId" AND "tenantId" = NEW."tenantId" AND "identityAccountId" = NEW."identityAccountId"
        AND "usedAt" IS NULL AND "revokedAt" IS NULL;
    IF v_usable >= 10 THEN
      RAISE EXCEPTION 'RECOVERY_CODE_LIMIT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."usedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'RECOVERY_CODE_FROZEN' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."id", NEW."organizationId", NEW."tenantId", NEW."identityAccountId", NEW."codeHash", NEW."batchId", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD."id", OLD."organizationId", OLD."tenantId", OLD."identityAccountId", OLD."codeHash", OLD."batchId", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'RECOVERY_CODE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF (NEW."usedAt" IS NULL) = (NEW."revokedAt" IS NULL) THEN
    -- Neither changed (no-op update) or both in one statement: refused either way.
    RAISE EXCEPTION 'RECOVERY_CODE_ONE_CHANGE' USING ERRCODE = '23514';
  END IF;
  IF NEW."usedAt" IS NOT NULL THEN
    PERFORM luxia_organization_lock_active(NEW."organizationId"); -- a code is consumed only for an ACTIVE organization
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_recovery_code_guard() FROM PUBLIC;
CREATE TRIGGER recovery_code_guard BEFORE INSERT OR UPDATE OR DELETE ON "LocalRecoveryCode"
FOR EACH ROW EXECUTE FUNCTION luxia_recovery_code_guard();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON FUNCTION luxia_recovery_code_guard() FROM app_user;
  END IF;
END $$;

-- Post-conditions: every pre-existing code is unusable.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "LocalRecoveryCode" WHERE "usedAt" IS NULL AND "revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_PRE_B2_CODES_USABLE';
  END IF;
END $$;

RESET lock_timeout;
