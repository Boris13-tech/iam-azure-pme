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
  v_role oid;
  v_database oid := (SELECT oid FROM pg_database WHERE datname = current_database());
  v_allowed oid[];
  v_problems text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luxia_retention') THEN
    -- NOINHERIT: it never gains a privilege by being granted another role. No LOGIN: the password is the operator's,
    -- set outside any migration, so no credential is ever written here. The operator also enables LOGIN, which a
    -- password alone does not (Codex F3, review of #196).
    CREATE ROLE luxia_retention NOLOGIN NOINHERIT;
  END IF;
  v_role := (SELECT oid FROM pg_roles WHERE rolname = 'luxia_retention');
  -- The four entry points, by exact signature: a name alone would also admit an overload created beside them.
  v_allowed := ARRAY[
    'public.luxia_retention_purge_transactions(integer, boolean)'::regprocedure::oid,
    'public.luxia_retention_purge_invitations(integer, boolean)'::regprocedure::oid,
    'public.luxia_retention_pseudonymize_retired(integer, boolean)'::regprocedure::oid,
    'public.luxia_retention_status()'::regprocedure::oid];

  -- A role of this name may already exist, from an earlier attempt or from someone else's hand, and the grants below
  -- would then be added to whatever it already carries. It is validated either way, and the migration fails closed.
  --
  -- Three reviews each found another way to be more than the narrow worker while passing a list of refusals
  -- (attributes, then granted privileges, then column privileges, grant options, settings, members, catalog objects,
  -- overloads, types). So privileges and ownership are no longer enumerated by kind: pg_shdepend is the cluster's own
  -- record of every object, in every database, that refers to the role through a privilege, an ownership or a policy,
  -- and anything there beyond exactly what this migration grants is refused (third review of #196).
  SELECT string_agg(problem, ', ' ORDER BY problem) INTO v_problems FROM (
    SELECT 'superuser' AS problem FROM pg_roles WHERE oid = v_role AND rolsuper
    UNION ALL SELECT 'bypassrls' FROM pg_roles WHERE oid = v_role AND rolbypassrls
    UNION ALL SELECT 'createrole' FROM pg_roles WHERE oid = v_role AND rolcreaterole
    UNION ALL SELECT 'createdb' FROM pg_roles WHERE oid = v_role AND rolcreatedb
    UNION ALL SELECT 'replication' FROM pg_roles WHERE oid = v_role AND rolreplication
    UNION ALL SELECT 'inherit' FROM pg_roles WHERE oid = v_role AND rolinherit
    -- Memberships, both ways: what it can become, and who can become it.
    UNION ALL SELECT 'member of ' || r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = v_role
    -- One member is expected: since PostgreSQL 16, a role created by a non-superuser is granted to its creator with
    -- the admin option only (no SET, no INHERIT), and that is how Production's owner creates it here. Refusing it
    -- made the migration refuse its own role on Production (Claude Opus and Gemini 4 Hydrogen, fourth review of #196).
    -- The migrating role already holds more than the worker; any other member, or that grant with SET or INHERIT
    -- (set_option and inherit_option exist from PostgreSQL 16, read through to_jsonb so PostgreSQL 15 parses this too),
    -- is still refused.
    UNION ALL SELECT 'has the member ' || r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE m.roleid = v_role AND NOT (m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND m.admin_option
        AND NOT coalesce((to_jsonb(m) ->> 'set_option')::boolean, false) AND NOT coalesce((to_jsonb(m) ->> 'inherit_option')::boolean, false))
    -- A setting attached to the role applies to every session it opens: a superuser's ALTER ROLE ... SET
    -- session_replication_role = replica, for one, would silence the guard triggers for the worker's writes. Timeouts
    -- only narrow a session, and are how this repository hardens its service roles, so those four are accepted.
    UNION ALL SELECT 'carries the setting ' || split_part(c.setting, '=', 1) FROM pg_db_role_setting rs
      CROSS JOIN unnest(rs.setconfig) c(setting) WHERE rs.setrole = v_role
        AND split_part(c.setting, '=', 1) NOT IN ('statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'idle_session_timeout')
    -- Everything the cluster records as referring to the role. Allowed: in this database, EXECUTE on the four entry
    -- points and USAGE on schema public; on databases, CONNECT (judged below, for its kind and its grant option).
    -- Another database of the cluster cannot be read from here, so what it holds there is judged by shape: at most the
    -- four entry points' kind of object, created by a migration (an object id from 16384 up, never a built-in such as
    -- pg_read_file), and schema public (id 2200). Which user function it is cannot be named from here; that database's
    -- own migration and activation judge it (Claude Opus and Gemini 4 Hydrogen, fourth review of #196).
    UNION ALL SELECT CASE d.deptype WHEN 'o' THEN 'owns ' WHEN 'r' THEN 'is named in ' ELSE 'holds a privilege on ' END
        || CASE WHEN d.dbid IN (0, v_database) THEN coalesce(pg_describe_object(d.classid, d.objid, d.objsubid), d.classid::regclass::text)
                ELSE d.classid::regclass::text || ' in another database' END
      FROM pg_shdepend d
      WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = v_role
        AND NOT (d.deptype = 'a' AND (
              (d.dbid = v_database AND d.objsubid = 0 AND d.classid = 'pg_proc'::regclass AND d.objid = ANY (v_allowed))
           OR (d.dbid = v_database AND d.classid = 'pg_namespace'::regclass AND d.objid = 'public'::regnamespace)
           OR (d.dbid = 0 AND d.classid = 'pg_database'::regclass)
           OR (d.dbid NOT IN (0, v_database) AND d.objsubid = 0 AND d.classid = 'pg_proc'::regclass AND d.objid >= 16384)
           OR (d.dbid NOT IN (0, v_database) AND d.classid = 'pg_namespace'::regclass AND d.objid = 2200)))
    -- And no more than the four functions in any other database.
    UNION ALL SELECT 'holds a privilege on ' || count(*) || ' functions in another database' FROM pg_shdepend d
      WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = v_role AND d.deptype = 'a'
        AND d.dbid NOT IN (0, v_database) AND d.classid = 'pg_proc'::regclass
      GROUP BY d.dbid HAVING count(*) > 4
    -- What the allowed entries may carry: EXECUTE and USAGE as such, CONNECT on a database, never the grant option,
    -- which would let the worker hand EXECUTE back to app_user between two runs of the activation gate.
    UNION ALL SELECT 'holds ' || a.privilege_type || CASE WHEN a.is_grantable THEN ' with the grant option' ELSE '' END
        || ' on the database ' || db.datname
      FROM pg_database db CROSS JOIN aclexplode(db.datacl) a
      WHERE a.grantee = v_role AND (a.privilege_type <> 'CONNECT' OR a.is_grantable)
    UNION ALL SELECT 'holds ' || a.privilege_type || CASE WHEN a.is_grantable THEN ' with the grant option' ELSE '' END
        || ' on the schema public'
      FROM aclexplode((SELECT nspacl FROM pg_namespace WHERE oid = 'public'::regnamespace)) a
      WHERE a.grantee = v_role AND (a.privilege_type <> 'USAGE' OR a.is_grantable)
    UNION ALL SELECT 'may grant EXECUTE on ' || p.oid::regprocedure::text || ' to others'
      FROM pg_proc p CROSS JOIN aclexplode(p.proacl) a
      WHERE p.oid = ANY (v_allowed) AND a.grantee = v_role AND a.is_grantable
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
