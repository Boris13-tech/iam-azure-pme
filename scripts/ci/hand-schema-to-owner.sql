-- CI only: hands every object of schema public, and the role running this's default privileges there, to another
-- role, so a disposable copy is owned the way a Production backup restored as it is stays owned (by Production's
-- owner, not by the role verifying it). Used by the G4 post-restore CI step; never run against Production.
--
--   psql -v ON_ERROR_STOP=1 -v owner=<role> -f scripts/ci/hand-schema-to-owner.sql <disposable copy>
SELECT set_config('luxia_ci.hand_to', :'owner', false) IS NULL AS unset \gset
DO $$
DECLARE
  v_owner text := current_setting('luxia_ci.hand_to');
  v_object record;
BEGIN
  IF current_database() !~ '^luxia_restore' THEN
    RAISE EXCEPTION 'hand-schema-to-owner runs only on a disposable copy, not on %', current_database();
  END IF;
  -- Tables, views and standalone sequences; a table's own sequences and indexes follow it.
  FOR v_object IN SELECT c.oid::regclass AS name, c.relkind FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         OR (c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))) LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE v_object.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE'
        WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, v_object.name, v_owner);
  END LOOP;
  FOR v_object IN SELECT p.oid::regprocedure AS name, p.prokind FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I', CASE v_object.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
      v_object.name, v_owner);
  END LOOP;
  FOR v_object IN SELECT t.oid::regtype AS name FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace
      AND t.typtype IN ('e', 'd') OR (t.typnamespace = 'public'::regnamespace AND t.typtype = 'c'
        AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')) LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO %I', v_object.name, v_owner);
  END LOOP;
  -- The default privileges the role running this gave in schema public, given by the new owner instead.
  FOR v_object IN SELECT da.defaclobjtype, a.privilege_type, a.grantee FROM pg_default_acl da CROSS JOIN aclexplode(da.defaclacl) a
      WHERE da.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        AND da.defaclnamespace = 'public'::regnamespace AND a.grantee <> da.defaclrole LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT %s ON %s TO %s', v_owner, v_object.privilege_type,
      CASE v_object.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' END,
      CASE WHEN v_object.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_object.grantee)) END);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE %s ON %s FROM %s', current_user, v_object.privilege_type,
      CASE v_object.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' END,
      CASE WHEN v_object.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_object.grantee)) END);
  END LOOP;
END $$;
