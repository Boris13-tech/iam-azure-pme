-- Issue #150 (D8.4), operator decision of 2026-11-14, option A: the daily retention job runs as its own database role.
--
-- The four retention entry points are SECURITY DEFINER with fixed predicates and bounded batches, and the HTTP endpoint
-- is protected by CRON_SECRET. Until now they were executable by app_user, the role that serves every web request, so
-- the privilege to run a destructive job sat on the role exposed to public traffic: any path reachable as app_user
-- could call R3 or R4 and delete eligible rows early, with no plan and no operator. That privilege becomes material
-- the day R4 or R6 enforces, which is why #150 gates that.
--
-- luxia_retention holds EXECUTE on those four functions and nothing else of its own: no table, no sequence, no other
-- definer function, whether granted to it or to PUBLIC (the validation below reads what it can really do). Like every
-- role it keeps what PUBLIC holds by PostgreSQL's defaults: CONNECT and TEMPORARY, and EXECUTE on ordinary functions.
-- It is created NOLOGIN here; the operator enables its login and sets its password with
-- scripts/ops/set-retention-password.mjs, and declares LUXIA_RETENTION_DATABASE_URL on the Production environment, which the job's own connection uses. app_user keeps no EXECUTE on any of them, and the
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
    -- PostgreSQL 16+ has just granted the role to its creator, admin only. When createrole_self_grant is set, the
    -- creator also grants it to itself a second time, with SET or INHERIT: that second grant is taken back here, so
    -- only the narrow one remains whatever that setting is in Production (sixth review of #196). Shown on PostgreSQL
    -- 17: two rows, the second granted by the creator itself; after this, the admin-only one alone.
    IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'luxia_retention'::regrole
        AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND m.grantor = m.member) THEN
      EXECUTE format('REVOKE luxia_retention FROM %I GRANTED BY %I', current_user, current_user);
    END IF;
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
    -- The creator is named by what it owns, not by who runs this block: the activation gate re-runs it as app_user,
    -- and keyed to current_user it refused Production's own owner at every activation (fifth review of #196).
    UNION ALL SELECT 'has the member ' || r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      -- The owner of the retention functions only: it can already do everything the worker can. The database's owner was
      -- accepted too for a round, but where it is another role, admin on the worker would let it hand itself the job's
      -- power (Gemini 4 Neon F-03, seventh review). On Neon both are the owner role.
      -- PostgreSQL 15 has no set_option or inherit_option: there every member can SET ROLE, so a missing column counts
      -- as SET and INHERIT granted, and the exception never applies there (Gemini 4 Neon F-04, seventh review).
      -- "The owner" means the owner of all four entry points: the owner of one only could use its admin option to reach
      -- the others' purges through the worker (Codex F1, eighth review).
      WHERE m.roleid = v_role AND NOT (m.member = ALL (SELECT proowner FROM pg_proc WHERE oid = ANY (v_allowed))
        AND (SELECT count(*) FROM pg_proc WHERE oid = ANY (v_allowed)) = 4
        AND m.admin_option
        AND NOT coalesce((to_jsonb(m) ->> 'set_option')::boolean, true) AND NOT coalesce((to_jsonb(m) ->> 'inherit_option')::boolean, true))
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
    -- What it can really do, however it came by it: pg_shdepend records only what names the role, so a grant to
    -- PUBLIC reached it unseen (GRANT TRUNCATE ON "Invitation" TO PUBLIC, Codex F1, ninth review of #196). The worker
    -- touches no table, column or sequence itself, creates nothing, and runs no other definer function.
    -- Read in every schema but PostgreSQL's own, information_schema, and Neon's neon_auth in Production: those are the
    -- platform's, whose grants to PUBLIC no release controls (Gemini 4 Hydrogen F-02, tenth review). Any other schema,
    -- one an owner could create, is read too (Codex F2, eleventh review).
    UNION ALL SELECT 'can ' || lower(p) || ' ' || c.oid::regclass::text FROM pg_class c
      -- MAINTAIN exists from PostgreSQL 17 (Production's version); naming it on 15 would raise (Codex F1, tenth review).
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
        || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END) p
      WHERE c.relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname NOT IN ('information_schema', 'neon_auth'))
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_table_privilege(v_role, c.oid, p)
    UNION ALL SELECT 'can use columns of ' || c.oid::regclass::text FROM pg_class c
      WHERE c.relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname NOT IN ('information_schema', 'neon_auth'))
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_any_column_privilege(v_role, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
    UNION ALL SELECT 'can ' || lower(p) || ' sequence ' || c.oid::regclass::text FROM pg_class c
      CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) p
      WHERE c.relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname NOT IN ('information_schema', 'neon_auth'))
        AND c.relkind = 'S' AND has_sequence_privilege(v_role, c.oid, p)
    UNION ALL SELECT 'can create in schema ' || n.nspname FROM pg_namespace n
      WHERE n.oid IN (SELECT oid FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname NOT IN ('information_schema', 'neon_auth')) AND has_schema_privilege(v_role, n.oid, 'CREATE')
    UNION ALL SELECT 'can create in the database' WHERE has_database_privilege(v_role, v_database, 'CREATE')
    -- PostgreSQL's own functions that start revoked from PUBLIC (pg_read_file, lo_export and the like, per
    -- pg_init_privs) but that the worker can execute now, through any grant (Gemini 4 Neon F-01, eleventh review).
    UNION ALL SELECT 'can execute ' || p.oid::regprocedure::text FROM pg_proc p
      JOIN pg_init_privs ip ON ip.objoid = p.oid AND ip.classoid = 'pg_proc'::regclass AND ip.objsubid = 0
      WHERE p.pronamespace = 'pg_catalog'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM aclexplode(ip.initprivs) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        AND has_function_privilege(v_role, p.oid, 'EXECUTE')
    -- The same two settings changed for the whole server (ALTER SYSTEM, the configuration file), which no catalog row
    -- names: read as this session's defaults (Gemini 4 Neon F-03, eleventh review).
    UNION ALL SELECT 'the server starts sessions with ' || name || '=' || reset_val FROM pg_settings
      WHERE (name = 'session_replication_role' AND reset_val <> 'origin') OR (name = 'row_security' AND reset_val <> 'on')
    -- The same silencing set for every role or for the whole database, which names no role: only the two settings that
    -- switch the guards or the row policies off, so a platform's own database settings never refuse a Production
    -- (Gemini 4 Neon F-05, tenth review).
    UNION ALL SELECT 'every session here starts with ' || c.setting FROM pg_db_role_setting rs
      CROSS JOIN unnest(rs.setconfig) c(setting)
      WHERE rs.setrole = 0 AND rs.setdatabase IN (0, v_database)
        -- Only a value that switches them off: origin and on are the protective defaults (Codex F3, eleventh review).
        AND ((lower(split_part(c.setting, '=', 1)) = 'session_replication_role'
              AND lower(trim(both '"' FROM split_part(c.setting, '=', 2))) <> 'origin')
          OR (lower(split_part(c.setting, '=', 1)) = 'row_security'
              AND lower(trim(both '"' FROM split_part(c.setting, '=', 2))) NOT IN ('on', 'true', 'yes', '1')))
    -- A setting a session normally cannot change, granted to PUBLIC or to the worker (GRANT SET ON PARAMETER, from
    -- PostgreSQL 15): session_replication_role alone would let it silence every guard trigger (Codex F2, tenth review).
    UNION ALL SELECT 'can ' || lower(k) || ' the parameter ' || pa.parname FROM pg_parameter_acl pa
      CROSS JOIN unnest(ARRAY['SET', 'ALTER SYSTEM']) k WHERE has_parameter_privilege(v_role, pa.parname, k)
    UNION ALL SELECT 'can execute the definer function ' || p.oid::regprocedure::text FROM pg_proc p
      WHERE p.prosecdef AND NOT p.oid = ANY (v_allowed)
        AND p.pronamespace IN (SELECT oid FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname NOT IN ('information_schema', 'neon_auth'))
        AND has_function_privilege(v_role, p.oid, 'EXECUTE')
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
