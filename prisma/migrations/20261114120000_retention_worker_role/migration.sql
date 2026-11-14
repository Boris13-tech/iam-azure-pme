-- Issue #150 (D8.4), operator decision of 2026-11-14, option A: the daily retention job runs as its own database role.
--
-- The four retention entry points are SECURITY DEFINER with fixed predicates and bounded batches, and the HTTP endpoint
-- is protected by CRON_SECRET. Until now they were executable by app_user, the role that serves every web request, so
-- the privilege to run a destructive job sat on the role exposed to public traffic: any path reachable as app_user
-- could call R3 or R4 and delete eligible rows early, with no plan and no operator. That privilege becomes material
-- the day R4 or R6 enforces, which is why #150 gates that.
--
-- luxia_retention holds EXECUTE on those four functions and nothing else: no table, no sequence, no other function. It
-- is created NOLOGIN here; the operator gives it a password in Neon and declares LUXIA_RETENTION_DATABASE_URL on the
-- Production environment, which the job's own connection uses. app_user keeps no EXECUTE on any of them, and the
-- activation gate's posture check refuses a Production where it does.
-- Lifting the dry run of R4 and R6 is a separate reviewed change, which this one and the lifecycle guard (#148) unblock.
SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luxia_retention') THEN
    -- NOINHERIT: it never gains a privilege by being granted another role. No LOGIN: the password is the operator's,
    -- set outside any migration, so no credential is ever written here.
    CREATE ROLE luxia_retention NOLOGIN NOINHERIT;
  END IF;
END $$;

-- CONNECT names the database it runs in, whatever that is (neondb in Production, luxia_db in CI, a disposable copy in a drill).
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO luxia_retention', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO luxia_retention;

GRANT EXECUTE ON FUNCTION luxia_retention_purge_transactions(integer, boolean) TO luxia_retention;
GRANT EXECUTE ON FUNCTION luxia_retention_purge_invitations(integer, boolean) TO luxia_retention;
GRANT EXECUTE ON FUNCTION luxia_retention_pseudonymize_retired(integer, boolean) TO luxia_retention;
GRANT EXECUTE ON FUNCTION luxia_retention_status() TO luxia_retention;

-- The role that serves web requests keeps none of them.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE EXECUTE ON FUNCTION luxia_retention_purge_transactions(integer, boolean) FROM app_user;
    REVOKE EXECUTE ON FUNCTION luxia_retention_purge_invitations(integer, boolean) FROM app_user;
    REVOKE EXECUTE ON FUNCTION luxia_retention_pseudonymize_retired(integer, boolean) FROM app_user;
    REVOKE EXECUTE ON FUNCTION luxia_retention_status() FROM app_user;
  END IF;
END $$;

RESET lock_timeout;
