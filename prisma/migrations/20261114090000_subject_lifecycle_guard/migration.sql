-- Issue #148, dependency of R6 enforcing: PostgreSQL owns the lifecycle dates of "Subject".
--
-- R6 (20261025120000) pseudonymizes a HUMAN subject RETIRED for more than 30 days, from "lifecycleChangedAt". That
-- date came from the application's clock, and the runtime role may UPDATE every column of "Subject": one statement
-- (lifecycleState = 'RETIRED', lifecycleChangedAt = now() - 31 days) skipped the 30-day window the design promises,
-- and so did a clock skew or an application defect. Not a privilege escalation (the runtime role can already rename
-- both fields directly), but a guarantee the database did not keep.
--
-- This guard makes the database the only writer of the lifecycle triple:
--   INSERT: "lifecycleChangedAt" is the database's time and "lifecycleVersion" is 1, whatever the caller sent.
--   UPDATE that changes "lifecycleState": the transition must be allowed (lib/identity/semantics.ts, RETIRED
--     terminal); "lifecycleChangedAt" becomes the database's time and "lifecycleVersion" the previous one plus 1.
--   UPDATE that does not change it: any change of "lifecycleChangedAt" or "lifecycleVersion" is REFUSED, not
--     silently reset, so a defect or a tampering attempt surfaces instead of passing unnoticed.
-- The legitimate writers keep working unchanged: updateSubject (every transition, which already asked the database
-- for the same values), invitation activation (PROVISIONING to ACTIVE), and R6 itself, which updates "name" only.
-- Any other column is untouched by this guard. DELETE is not guarded: R7's erasure and its own gate decide that.
SET lock_timeout = '5s';

CREATE FUNCTION luxia_subject_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  -- clock_timestamp(), not now(): now() is the transaction's start time, so a caller holding a transaction open for
  -- more than 30 days would have its retirement stamped with that old time and become eligible for R6 at once, which
  -- is the very hole this guard closes (Codex, review of #194). The type stays TIMESTAMP(3), the column's.
  v_now TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC');
  v_allowed TEXT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."lifecycleChangedAt" := v_now;
    NEW."lifecycleVersion" := 1;
    RETURN NEW;
  END IF;
  IF NEW."lifecycleState" IS DISTINCT FROM OLD."lifecycleState" THEN
    -- The transition table of lib/identity/semantics.ts, kept identical by an architecture test. RETIRED is terminal:
    -- its empty list refuses every change, so a pseudonymized person can never be moved back into an active state.
    v_allowed := CASE OLD."lifecycleState"
      WHEN 'PROVISIONING'      THEN ARRAY['ACTIVE', 'DISABLED', 'RETIRED']
      WHEN 'ACTIVE'            THEN ARRAY['SUSPENDED', 'DISABLED', 'RECOVERY_REQUIRED', 'RETIRED']
      WHEN 'SUSPENDED'         THEN ARRAY['ACTIVE', 'DISABLED', 'RECOVERY_REQUIRED', 'RETIRED']
      WHEN 'DISABLED'          THEN ARRAY['ACTIVE', 'RETIRED']
      WHEN 'RECOVERY_REQUIRED' THEN ARRAY['ACTIVE', 'SUSPENDED', 'DISABLED', 'RETIRED']
      WHEN 'RETIRED'           THEN ARRAY[]::TEXT[]
    END;
    -- A NULL target would make the comparison NULL, which an IF does not enter, so it is refused first: the column's
    -- NOT NULL would reject the row anyway, but the guard says why (Antigravity, review of #194).
    IF NEW."lifecycleState" IS NULL OR v_allowed IS NULL OR NOT (NEW."lifecycleState"::text = ANY (v_allowed)) THEN
      -- coalesce: a NULL target would make the whole DETAIL NULL, and PostgreSQL would then replace this refusal with
      -- "RAISE statement option cannot be null", hiding the code the runbooks name.
      RAISE EXCEPTION 'SUBJECT_LIFECYCLE_TRANSITION_INVALID' USING ERRCODE = '23514',
        DETAIL = OLD."lifecycleState"::text || ' -> ' || coalesce(NEW."lifecycleState"::text, 'null');
    END IF;
    -- The moment the statement ran, from the database's clock, never the caller's: R6's 30-day window rests on it.
    NEW."lifecycleChangedAt" := v_now;
    NEW."lifecycleVersion" := OLD."lifecycleVersion" + 1;
    RETURN NEW;
  END IF;
  -- No state change: the lifecycle date and version are immutable. Refused, so that a backdating attempt is visible.
  IF NEW."lifecycleChangedAt" IS DISTINCT FROM OLD."lifecycleChangedAt" THEN
    RAISE EXCEPTION 'SUBJECT_LIFECYCLE_DATE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."lifecycleVersion" IS DISTINCT FROM OLD."lifecycleVersion" THEN
    RAISE EXCEPTION 'SUBJECT_LIFECYCLE_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_subject_lifecycle_guard() FROM PUBLIC;
CREATE TRIGGER subject_lifecycle_guard BEFORE INSERT OR UPDATE ON "Subject"
  FOR EACH ROW EXECUTE FUNCTION luxia_subject_lifecycle_guard();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON FUNCTION luxia_subject_lifecycle_guard() FROM app_user;
  END IF;
END $$;

RESET lock_timeout;
