const fs = require('fs');
let ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
ci = ci.replace('- architecture/phase-5-legacy-cutover', '- architecture/phase-5-legacy-cutover\n      - security/phase-5e3-dependency-hardening');

ci = ci.replace("CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\n              GRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user;\n           END IF;\n        END", "CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\n           END IF;\n        END\n        $do$;\n        GRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user;");
fs.writeFileSync('.github/workflows/ci.yml', ci);

if (fs.existsSync('bootstrap.sql')) {
  let bs = fs.readFileSync('bootstrap.sql', 'utf8');
  bs = bs.replace("CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\n              GRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user;\n           END IF;\n        END\n        $;", "CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\n           END IF;\n        END\n        $;\n        GRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user;");
  // in case the indentation was different:
  bs = bs.replace(/CREATE ROLE app_user.*?;\s*GRANT EXECUTE ON FUNCTION.*?;\s*END IF;\s*END\s*\\$;/s, "CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\n   END IF;\nEND\n$;\nGRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user;");
  fs.writeFileSync('bootstrap.sql', bs);
}
