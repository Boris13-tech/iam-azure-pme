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
  -- The same expression and type as the retention guards and purges: one clock, the database's.
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');
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
    IF v_allowed IS NULL OR NOT (NEW."lifecycleState"::text = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'SUBJECT_LIFECYCLE_TRANSITION_INVALID' USING ERRCODE = '23514',
        DETAIL = OLD."lifecycleState"::text || ' -> ' || NEW."lifecycleState"::text;
    END IF;
    -- The moment the state changed is the database's, never the caller's: this is what R6's 30-day window rests on.
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
