const fs = require('fs');
let f = '.github/workflows/ci.yml';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(
  "CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;",
  "CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\n              GRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user;"
);
fs.writeFileSync(f, c);
