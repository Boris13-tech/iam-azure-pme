const fs = require('fs');

const stepNew = - name: Bootstrap RLS runtime role
      run: |
        cat << 'EOF' > bootstrap.sql
        DO
        \\\\$
        BEGIN
           IF NOT EXISTS (
              SELECT FROM pg_catalog.pg_roles
              WHERE rolname = 'app_user') THEN
              CREATE ROLE app_user LOGIN PASSWORD 'app_password'
                NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
           END IF;
        END
        \\\\$;

        GRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user;
        GRANT CONNECT ON DATABASE luxia_db TO app_user;
        GRANT USAGE ON SCHEMA public TO app_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
        EOF

        PSQL_URL="\"
        psql -v ON_ERROR_STOP=1 "" -f bootstrap.sql.replace(/\\\\\\$/g, '$');

let ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
// replace the entire block manually using indexOf or regex
const startIndex = ci.indexOf('- name: Bootstrap RLS runtime role');
const endIndex = ci.indexOf('- name: Run Security Tests');
if (startIndex !== -1 && endIndex !== -1) {
  ci = ci.substring(0, startIndex) + stepNew + "\n\n    " + ci.substring(endIndex);
  fs.writeFileSync('.github/workflows/ci.yml', ci);
}

const bootstrapNew = DO
$
BEGIN
   IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_roles
      WHERE rolname = 'app_user') THEN
      CREATE ROLE app_user LOGIN PASSWORD 'app_password'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
   END IF;
END
$;

GRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user;
GRANT CONNECT ON DATABASE luxia_db TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;;

fs.writeFileSync('bootstrap.sql', bootstrapNew);

