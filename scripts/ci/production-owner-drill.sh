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
APP_URL="postgresql://app_user:app_password@${host}/neondb"
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
# The re-check runs where the activation gate runs it: as app_user, the posture step's connection. Running it as the
# owner hid that the creator exception was keyed to whoever ran it (fifth review of #196).
validate() { psql -X -q -v ON_ERROR_STOP=1 "$APP_URL" -f "$work/validate.sql"; }
# Refused, and for the reason given: a refusal for anything else is a failure of the drill.
refused() { if validate 2>"$work/err"; then echo "FAIL: $2 passed the re-check"; exit 1; fi
  grep -q "$1" "$work/err" || { echo "FAIL: $2 refused for another reason: $(cat "$work/err")"; exit 1; }; echo "ok: $2 refused"; }

step "Every migration, as that owner"
DATABASE_URL="${OWNER_URL}?schema=public" npx prisma migrate deploy
echo "creator membership: $(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM pg_auth_members WHERE roleid = 'luxia_retention'::regrole")"

step "The activation gate, as that owner, then its re-check of the worker role"
gate; validate; expect "app_user=0 retention=4" "after the gate"

step "Drift is refused at the next activation"
admin() { psql -X -q -v ON_ERROR_STOP=1 "$ADMIN_URL" -c "$1"; }
admin "ALTER ROLE luxia_retention SET session_replication_role = replica"
refused "carries the setting session_replication_role" "a setting that silences the guards"
admin "ALTER ROLE luxia_retention RESET session_replication_role"
# The creator's own grant is accepted only as PostgreSQL 16+ makes it: admin, no SET, no INHERIT.
admin "GRANT luxia_retention TO luxia_owner WITH SET TRUE"
refused "has the member luxia_owner" "the creator's grant with SET"
admin "GRANT luxia_retention TO luxia_owner WITH SET FALSE"
admin "GRANT luxia_retention TO luxia_owner WITH INHERIT TRUE"
refused "has the member luxia_owner" "the creator's grant with INHERIT"
admin "GRANT luxia_retention TO luxia_owner WITH INHERIT FALSE"
admin "GRANT luxia_retention TO app_user"
refused "has the member app_user" "another member"
admin "REVOKE luxia_retention FROM app_user"
validate; echo "ok: the creator's admin-only grant alone passes"

step "Rollback, as that owner; then the gate as for a release from before D8.4"
# Production's role can log in (the operator enabled it), so the rollback must be seen to take that away: without
# this, the check below held whatever the rollback did (fifth review of #196).
admin "ALTER ROLE luxia_retention LOGIN"
psql -X -q -1 -v ON_ERROR_STOP=1 "$OWNER_URL" -f docs/operations/RETENTION-WORKER-ROLE-ROLLBACK.sql
[ "$(psql -X -At "$OWNER_URL" -c "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'luxia_retention'")" = "f" ] || { echo "FAIL: role can still log in"; exit 1; }
gate; expect "app_user=4 retention=0" "after the rollback and the gate"

step "Login back (the operator, in Neon), migrate deploy, the gate"
psql -X -q -v ON_ERROR_STOP=1 "$OWNER_URL" -c "ALTER ROLE luxia_retention LOGIN"
DATABASE_URL="${OWNER_URL}?schema=public" npx prisma migrate deploy
gate; validate; expect "app_user=0 retention=4" "after redeploy and the gate"
echo; echo "PRODUCTION-OWNER DRILL PASS"
