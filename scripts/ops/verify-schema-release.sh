#!/usr/bin/env bash
# The database's schema is exactly the authorized release's: the migrations Prisma recorded as applied (finished, not
# rolled back) are, name for name, the migration directories of the release, and none is half-applied. Used after the
# activation gate applies a release, and before the code of a release is deployed: code and schema are one version.
# Usage: verify-schema-release.sh <release's prisma/migrations directory> [--before-migrate]. Env: PSQL_URL (read-only).
# --before-migrate: the database may still miss some of the release's migrations, but holds none outside it (checked
# before the gate migrates, so that a database ahead of the release is refused before anything runs).
# Prints "SCHEMA MATCHES <count> migrations" or "REFUSED: ..." (exit 1); names only, never a value of the database.
set -euo pipefail

dir="${1:-}"
mode="${2:-exact}"
refuse() { echo "REFUSED: $*"; exit 1; }
[[ "$mode" == "exact" || "$mode" == "--before-migrate" ]] || refuse "unknown mode $mode"
[[ -n "${PSQL_URL:-}" ]] || refuse "PSQL_URL is not set"
[[ -d "$dir" ]] || refuse "the release's migrations directory $dir is missing"

expected="$(find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E '^[0-9]{14}_[A-Za-z0-9_]+$' | LC_ALL=C sort)" || true
[[ -n "$expected" ]] || refuse "the release has no migration"
query() { psql -X -q -At -v ON_ERROR_STOP=1 "$PSQL_URL" -c "$1"; }
applied="$(query 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1')" \
  || refuse "the database's migration history cannot be read"
applied="$(printf '%s\n' "$applied" | tr -d '\r' | sed '/^$/d' | LC_ALL=C sort)"
unfinished="$(query 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL')" \
  || refuse "the database's migration history cannot be read"
[[ "$(tr -d '\r' <<< "$unfinished")" == "0" ]] || refuse "a migration is half-applied (started, neither finished nor rolled back)"

missing="$(LC_ALL=C comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$applied"))"
extra="$(LC_ALL=C comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$applied"))"
if [[ "$mode" == "--before-migrate" ]]; then
  if [[ -n "$extra" ]]; then
    echo "applied in the database, but not in the release: $(tr '\n' ' ' <<< "$extra")"
    refuse "the database is ahead of the release"
  fi
  echo "SCHEMA WITHIN RELEASE: $(grep -c . <<< "$applied" || true) applied, $(grep -c . <<< "$missing" || true) to apply"
  exit 0
fi
if [[ -n "$missing" || -n "$extra" ]]; then
  [[ -z "$missing" ]] || echo "not applied in the database, but in the release: $(tr '\n' ' ' <<< "$missing")"
  [[ -z "$extra" ]] || echo "applied in the database, but not in the release: $(tr '\n' ' ' <<< "$extra")"
  refuse "the database's schema is not the release's"
fi
echo "SCHEMA MATCHES $(wc -l <<< "$expected" | tr -d ' ') migrations"
