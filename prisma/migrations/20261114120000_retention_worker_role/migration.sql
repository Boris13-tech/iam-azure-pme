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

DO $$
DECLARE
  v_problems text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luxia_retention') THEN
    -- NOINHERIT: it never gains a privilege by being granted another role. No LOGIN: the password is the operator's,
    -- set outside any migration, so no credential is ever written here. The operator also enables LOGIN, which a
    -- password alone does not (Codex F3, review of #196).
    CREATE ROLE luxia_retention NOLOGIN NOINHERIT;
  END IF;
  -- A role of this name may already exist, from an earlier attempt or from someone else's hand, and the grants below
  -- would then be added to whatever it already carries. It is validated either way, and the migration fails closed:
  -- an attribute, a membership or an owned object would make it more than the narrow worker this relies on. NOINHERIT
  -- does not help here, because a membership still permits SET ROLE (Codex F2, review of #196).
  SELECT string_agg(problem, ', ' ORDER BY problem) INTO v_problems FROM (
    SELECT 'superuser' AS problem FROM pg_roles WHERE rolname = 'luxia_retention' AND rolsuper
    UNION ALL SELECT 'bypassrls' FROM pg_roles WHERE rolname = 'luxia_retention' AND rolbypassrls
    UNION ALL SELECT 'createrole' FROM pg_roles WHERE rolname = 'luxia_retention' AND rolcreaterole
    UNION ALL SELECT 'createdb' FROM pg_roles WHERE rolname = 'luxia_retention' AND rolcreatedb
    UNION ALL SELECT 'replication' FROM pg_roles WHERE rolname = 'luxia_retention' AND rolreplication
    UNION ALL SELECT 'member of ' || r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
      WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention')
    UNION ALL SELECT 'owns the relation ' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention') AND left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
    UNION ALL SELECT 'owns the function ' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention') AND left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
    UNION ALL SELECT 'owns the schema ' || n.nspname FROM pg_namespace n
      WHERE n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention') AND left(n.nspname, 3) <> 'pg_'
    -- A privilege it was granted directly is just as much a capability as an attribute or an ownership, and no
    -- attribute names it: a pre-existing role holding TRUNCATE on RetentionRun would have passed every check above
    -- and kept that privilege, which forced row-level security does not constrain (Codex F1, second review of #196).
    -- What it may already hold is exactly what this migration itself grants, and nothing else, so applying it to a
    -- database where it has already run is not a problem and anything wider is.
    UNION ALL SELECT 'holds ' || a.privilege_type || ' on the relation ' || c.relname FROM pg_class c
      CROSS JOIN aclexplode(c.relacl) a JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention')
        AND left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
    UNION ALL SELECT 'holds ' || a.privilege_type || ' on the function ' || p.proname FROM pg_proc p
      CROSS JOIN aclexplode(p.proacl) a JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention')
        AND left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
        AND NOT (a.privilege_type = 'EXECUTE' AND n.nspname = 'public' AND p.proname IN (
          'luxia_retention_purge_transactions', 'luxia_retention_purge_invitations',
          'luxia_retention_pseudonymize_retired', 'luxia_retention_status'))
    UNION ALL SELECT 'holds ' || a.privilege_type || ' on the schema ' || n.nspname FROM pg_namespace n
      CROSS JOIN aclexplode(n.nspacl) a
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention') AND left(n.nspname, 3) <> 'pg_'
        AND NOT (a.privilege_type = 'USAGE' AND n.nspname = 'public')
    -- This database only: the role is one for the whole cluster, so in a cluster with several databases (CI's
    -- restored copy, a drill's scratch database) it rightly holds CONNECT on the others, and judging those here
    -- would refuse every database but the first to be migrated.
    UNION ALL SELECT 'holds ' || a.privilege_type || ' on the database ' || d.datname FROM pg_database d
      CROSS JOIN aclexplode(d.datacl) a
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention')
        AND d.datname = current_database() AND a.privilege_type <> 'CONNECT'
    -- And a default privilege would give it the next object created, without granting it anything today.
    UNION ALL SELECT 'is given ' || a.privilege_type || ' on objects created later' FROM pg_default_acl da
      CROSS JOIN aclexplode(da.defaclacl) a
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention')
    -- Third review of #196 (Antigravity findings 1 to 4): four more ways to be more than the narrow worker.
    -- A column privilege lives in pg_attribute, not in the table's own list: SELECT (email) ON "Subject" passed.
    UNION ALL SELECT 'holds ' || a.privilege_type || ' on the column ' || c.relname || '.' || t.attname FROM pg_attribute t
      JOIN pg_class c ON c.oid = t.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN aclexplode(t.attacl) a
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention')
        AND left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
    -- Even an allowed privilege must not carry the grant option: the worker could hand EXECUTE back to app_user, the
    -- very thing #150 removes, between two runs of the activation gate.
    UNION ALL SELECT 'may grant ' || a.privilege_type || ' to others' FROM (
        SELECT (aclexplode(p.proacl)).* FROM pg_proc p
        UNION ALL SELECT (aclexplode(n.nspacl)).* FROM pg_namespace n
        UNION ALL SELECT (aclexplode(d.datacl)).* FROM pg_database d WHERE d.datname = current_database()) a
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention') AND a.is_grantable
    -- A setting attached to the role applies to every session it opens: a superuser's ALTER ROLE … SET
    -- session_replication_role = replica, for one, would silence the guard triggers for the worker's writes.
    UNION ALL SELECT 'carries the setting ' || split_part(s.setting, '=', 1) FROM pg_db_role_setting rs
      CROSS JOIN unnest(rs.setconfig) s(setting)
      WHERE rs.setrole = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention')
    -- And whoever is a member of it can become it: its EXECUTE would be theirs too.
    UNION ALL SELECT 'has the member ' || r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention')
  ) p;
  IF v_problems IS NOT NULL THEN
    RAISE EXCEPTION 'RETENTION_ROLE_UNSAFE' USING ERRCODE = '42501', DETAIL = v_problems;
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
