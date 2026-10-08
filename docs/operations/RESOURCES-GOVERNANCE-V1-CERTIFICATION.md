# Resource foundation — local certification evidence

Date: 2026-10-04 (Europe/Bucharest).
Branch: feat/resources-governance-v1, based on main 07bbd51693949d06994b20e2aa1ee25e46e1d17b.
The exact certified commit and GitHub CI run are reported in the Draft PR; this document is part of that commit.

Environment: dedicated schema-only Neon branch br-withered-hall-ahvj9ru3, database luxia_resources_cert. No Production data copied. Provider certification branch/store and PR #12 unchanged.

Executed `scripts/certify-resources-local.cjs` with runtime credentials injected only in memory and LUXIA_RESOURCE_FULL=true. Raw command output suppressed where credentials might occur.

| Gate | Observed result |
| --- | --- |
| All main migrations plus additive resource foundation | PASS |
| app_user NOSUPERUSER/NOBYPASSRLS/no table ownership | PASS |
| Resource model, six required types | PASS |
| Entitlement → ResourceScope → Resource binding | PASS |
| RESOURCE / RESOURCE_GROUP / TENANT enforcement | PASS |
| Native authorization and default DENY | PASS |
| Cross-tenant reads/writes and composite FK enforcement | PASS; foreign access DENY |
| Canonical audit committed SUCCESS/DENIED; audit failure rolls back writes | PASS |
| Native grant authority, expiry bounds, self-grant denial | PASS |
| Real HTTP resource/scope/entitlement/assignment/authorize/audit APIs | PASS |
| Invalid/revoked persisted session HTTP refusal | PASS |
| Legacy authority in new services | NONE (architecture boundary tests) |
| Legacy rows/bridges changed | NONE (before/after checksum) |
| Resources unit/architecture and real PostgreSQL/RLS suite | PASS |
| Existing security suite | PASS |
| Provider contracts (including Entra parity) | PASS |
| Identity suite | PASS |
| Operations suite and operational certification | PASS |
| Cutover readiness | PASS |
| TypeScript / lint | PASS |
| Next production build, local only | PASS |

Earlier failures were not hidden: preparation initially attempted an unnecessary role-flag ALTER rejected by PostgreSQL; the runner now verifies flags first and only rotates the isolated role password. The first service tests exposed Prisma's unsupported void result for pg_advisory_xact_lock; casting the result to text fixed it. The complete local certification was then replayed successfully.

Unit-only execution without LUXIA_RESOURCE_RLS=true skips the real DB tests and must not be cited as a PostgreSQL PASS. CI explicitly enables the real tests against its isolated PostgreSQL service; no owner credentials are passed to the HTTP application process. Test fixtures are limited to the isolated database and expire with the branch on 2026-10-06T12:00:00Z.

No external provider calls, no Production deployment or mutation, no PR #12 change. SoD/Access Reviews not started. Registering a catalogue resource alone does not prove an arbitrary external application enforces Luxia authorization.
