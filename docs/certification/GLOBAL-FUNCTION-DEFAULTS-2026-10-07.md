# Separate global function default privilege hardening

Candidate application/migrations: `c991c06e802fab4458fafccf8e0407f964d1e134`.
Local certification-only changes extend exact endpoint allowlists; no application,
business logic or candidate migration SQL is changed. No commit, merge or deployment.

## Environment

- Neon project: `hidden-leaf-91460552`.
- Isolated normal clone: `br-restless-meadow-ahtmecqd`.
- Parent: `br-billowing-frog-ahtirmax`, cloned at LSN `0/2EBDC10`.
- Expiration: `2026-10-09T19:42:28Z`.
- `neondb`: copied schema/data, used for ACL comparisons and the three pending migrations.
- `luxia_reviews_cert`: empty separate database on the same clone, used for test fixtures.
- No Production writes and no provider calls. URLs/passwords remain process-local.

## Independent hardening

`SELECT current_user, session_user` returned `neondb_owner` for both on the
connection also supplied to Prisma migrate deploy. Therefore the role-neutral
global statement in `docs/operations/hardening-global-function-defaults.sql`
targets the real creator. It deliberately contains no `IN SCHEMA` clause.

After execution, `pg_default_acl` has the global function entry
`neondb_owner: {neondb_owner=X/neondb_owner}`. The other observed entries are
schema-specific table/sequence defaults, not function EXECUTE grants. No explicit
default ACL entry grants PUBLIC function EXECUTE.

Existing public function OIDs and ACLs were compared exactly before/after
hardening and again after candidate migrations: unchanged. `resolve_session`
body, ACL and app_user EXECUTE privilege are unchanged. Its invalid-session
result is unchanged; valid-session coverage belongs to the full RLS/HTTP suite.

The actual `luxia_acl_probe()` was created after hardening and checked with
`has_function_privilege`: PUBLIC=false, owner=true, app_user=false. It was
removed in a finally block; catalog verification confirms its absence.

## Candidate migration result

All three pending migrations applied directly to the clone without manual schema
changes: 18 finished, non-rolled-back migration records total.

| Function | PUBLIC EXECUTE | app_user EXECUTE | owner EXECUTE |
|---|---|---|---|
| luxia_sod_scope_contains | NO | YES | YES |
| luxia_sod_assignment_guard | NO | NO | YES |
| luxia_review_immutable_guard | NO | NO | YES |

All six new tables have RLS ENABLED and FORCED, with no app_user ownership.
The copied runtime role is NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB.

The existing full-suite runner uses broader **fixture-only table DML grants** in
the empty certification database. Those are not Production recommendations or
evidence that all Production table privileges are minimal. The minimum function
EXECUTE matrix is certified separately on the unmodified copied runtime role.

## Full suite

Completed successfully on 2026-10-07, isolated runner exit code 0:

- Migrations: PASS.
- Runtime posture and membership check: PASS.
- Resources PostgreSQL/RLS + unit/architecture (including SoD, concurrency,
  Access Review KEEP/REVOKE/immutability, cross-tenant denial, canonical audit,
  persisted-session HTTP and legacy preservation): PASS.
- Existing security: PASS.
- Provider contracts (no real provider invocation): PASS.
- Identity: PASS.
- Operations and operational certification: PASS.
- Cutover readiness: PASS.
- TypeScript: PASS.
- Lint: PASS.
- Production build, local only: PASS.

CI-equivalent: PASS. This is a local replay, not a newly dispatched GitHub CI
run and not a certification of an uncreated commit. The candidate remains
`c991c06e802fab4458fafccf8e0407f964d1e134`; the local test harness additions and
separate hardening artifacts remain uncommitted. No candidate migration or
business implementation was modified.

Production authorization remains pending. The clone expires automatically;
no copied business row contents are exported into this document.
