-- Rollback of 20261114090000_subject_lifecycle_guard (issue #148). Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Removes the guard, so the application's clock writes the lifecycle dates of "Subject" again. The lifecycle dates
-- already stamped by the database stay as they are.
--
-- R6 MUST NOT ENFORCE WITHOUT THIS GUARD: its 30-day window would again rest on a date the runtime role can set
-- freely (issue #148). Before rolling back, check that R6 is not enforcing in Production; the retention job keeps R4
-- and R6 as dry runs unless a later reviewed change lifts that, and the database refuses an enforced call from the
-- runtime role.
-- Possible while it is the last applied migration; a later one may depend on it.
SET lock_timeout = '5s';
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" > '20261114090000_subject_lifecycle_guard' AND "rolled_back_at" IS NULL) THEN
      RAISE EXCEPTION 'ROLLBACK_NOT_LATEST_MIGRATION' USING ERRCODE = '55000';
    END IF;
  END IF;
END $$;
DROP TRIGGER IF EXISTS subject_lifecycle_guard ON "Subject";
DROP FUNCTION IF EXISTS luxia_subject_lifecycle_guard();
DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114090000_subject_lifecycle_guard';
  END IF;
END $$;
RESET lock_timeout;
