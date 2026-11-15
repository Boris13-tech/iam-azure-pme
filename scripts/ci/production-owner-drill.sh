#!/usr/bin/env bash
# CI only: the migrations and the activation gate, run the way Production runs them — by an owner that is NOT a
# superuser, on PostgreSQL 17 — then a D8.4 rollback and redeploy. CI's other jobs migrate as the container's
# superuser, which hid that PostgreSQL 16+ makes a role's non-superuser creator a member of it (Claude Opus and
# Gemini 4 Hydrogen, fourth review of #196): the migration refused its own role, which only a run like this one shows.
#
#   ADMIN_URL=postgresql://<superuser>@<host>:<port>/postgres bash scripts/ci/production-owner-drill.sh
#
# Creates its own roles and database; uses only throwaway test credentials. Fails on the first deviation.
set -euo pipefail
: "${ADMIN_URL:?set ADMIN_URL to a superuser URL of a disposable PostgreSQL 17 server}"
base="${ADMIN_URL%/*}"; host="${base#*@}"
OWNER_URL="postgresql://luxia_owner:owner_password@${host}/neondb"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
step() { printf '\n== %s\n' "$*"; }
state() { psql -X -At "$OWNER_URL" -c "SELECT 'app_user=' || count(*) FILTER (WHERE has_function_privilege('app_user', p.oid, 'EXECUTE'))
  || ' retention=' || count(*) FILTER (WHERE has_function_privilege('luxia_retention', p.oid, 'EXECUTE'))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'luxia_retention%'"; }
expect() { local got; got="$(state)"; [ "$got" = "$1" ] || { echo "FAIL: $2: expected $1, got $got"; exit 1; }; echo "ok: $2 ($got)"; }

step "Production-like cluster: a non-superuser owner with CREATEROLE, and the runtime role"
psql -X -v ON_ERROR_STOP=1 "$ADMIN_URL" -q \
  -c "CREATE ROLE luxia_owner LOGIN PASSWORD 'owner_password' CREATEROLE CREATEDB BYPASSRLS NOSUPERUSER" \
  -c "CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOINHERIT NOBYPASSRLS" \
  -c "CREATE DATABASE neondb OWNER luxia_owner"
psql -X -v ON_ERROR_STOP=1 "${base}/neondb" -q -c "ALTER SCHEMA public OWNER TO luxia_owner"
[ "$(psql -X -At "$OWNER_URL" -c 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user')" = "f" ] || { echo "FAIL: owner is a superuser"; exit 1; }

# The activation gate's grant step and the migration's role validation, extracted from the files under test.
node -e '
const fs = require("fs");
const gate = fs.readFileSync(".github/workflows/production-activation-gate.yml", "utf8").replace(/\r/g, "");
const block = /Bootstrap least-privilege runtime grants[\s\S]*?<<\x27SQL\x27\n([\s\S]*?)\n\s*SQL\n/.exec(gate)[1].replace(/^ {10}/gm, "");
fs.writeFileSync(process.argv[1] + "/gate.sql", block);
const m = fs.readFileSync("prisma/migrations/20261114120000_retention_worker_role/migration.sql", "utf8");
const a = m.indexOf("DO $$");
fs.writeFileSync(process.argv[1] + "/validate.sql", m.slice(a, m.indexOf("END $$;", a) + 7) + "\n");' "$work"
gate() { psql -X -q -v ON_ERROR_STOP=1 --single-transaction "$OWNER_URL" -f "$work/gate.sql" >/dev/null; }
validate() { psql -X -q -v ON_ERROR_STOP=1 "$OWNER_URL" -f "$work/validate.sql"; }

step "Every migration, as that owner"
DATABASE_URL="${OWNER_URL}?schema=public" npx prisma migrate deploy
echo "creator membership: $(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM pg_auth_members WHERE roleid = 'luxia_retention'::regrole")"

step "The activation gate, as that owner, then its re-check of the worker role"
gate; validate; expect "app_user=0 retention=4" "after the gate"

step "Drift is refused at the next activation"
psql -X -q -v ON_ERROR_STOP=1 "$ADMIN_URL" -c "ALTER ROLE luxia_retention SET session_replication_role = replica"
if validate 2>"$work/err"; then echo "FAIL: a drifted role passed the re-check"; exit 1; fi
grep -q "carries the setting session_replication_role" "$work/err" && echo "ok: drift refused"
psql -X -q -v ON_ERROR_STOP=1 "$ADMIN_URL" -c "ALTER ROLE luxia_retention RESET session_replication_role"

step "Rollback, as that owner; then the gate as for a release from before D8.4"
psql -X -q -1 -v ON_ERROR_STOP=1 "$OWNER_URL" -f docs/operations/RETENTION-WORKER-ROLE-ROLLBACK.sql
[ "$(psql -X -At "$OWNER_URL" -c "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'luxia_retention'")" = "f" ] || { echo "FAIL: role can still log in"; exit 1; }
gate; expect "app_user=4 retention=0" "after the rollback and the gate"

step "Login back (the operator, in Neon), migrate deploy, the gate"
psql -X -q -v ON_ERROR_STOP=1 "$OWNER_URL" -c "ALTER ROLE luxia_retention LOGIN"
DATABASE_URL="${OWNER_URL}?schema=public" npx prisma migrate deploy
gate; validate; expect "app_user=0 retention=4" "after redeploy and the gate"
echo; echo "PRODUCTION-OWNER DRILL PASS"
