# Access Reviews v1 — isolated certification

Date: 2026-10-04. Branch: feat/resources-governance-v1 / PR #13. No Production access, migration, grant or deployment. PR #12 remains Draft at d604a48fa62fbec65676c0423a08645805d67129.

## Database and runtime

Fresh `luxia_reviews_cert` database on the existing schema-only Neon branch `br-withered-hall-ahvj9ru3`, project `hidden-leaf-91460552`. No business rows copied. Prisma applied `20261004180000_access_reviews_v1` without manual schema modification. The certification runner keeps owner/runtime URLs and generated runtime password in memory and does not publish raw subprocess/HTTP-server output.

Runtime service and HTTP proofs use `app_user`, not the fixture owner. Observed NOSUPERUSER, NOBYPASSRLS and no ownership of review tables. Both new tables have ENABLED + FORCED RLS; all 10 compound foreign keys are present. Valid reviewer/target/scope references and immutable-decision guards are exercised. Owner access is limited to migration, isolated fixture setup and an isolated test-only audit-failure trigger, removed in a finally block.

## Observed local results

- Access Review model: PASS.
- Campaign generation from active persisted Assignments: PASS; revoked/expired/unbound grants are excluded.
- Reviewer authorization: PASS; active native entitlement and exact assigned reviewer required.
- KEEP semantics: PASS; Assignment unchanged, no creation/reactivation.
- REVOKE atomic enforcement: PASS; decision, existing Assignment revoke and canonical audit commit together.
- Idempotency: PASS; exact replay returns original decision with one success audit, conflicting replay is denied.
- SoD re-check: PASS; newly active conflicting policy yields REQUIRES_REMEDIATION with committed DENIED evidence.
- Tenant isolation: PASS; foreign campaigns/items/evidence invisible under actual other-tenant context.
- Cross-tenant: DENY; an actual authorized reviewer in another tenant cannot read/decide this campaign or be selected by its creator.
- Self-review default: DENY; generation rejects own-access review, with database CHECK backstop.
- Canonical audit: PASS; safe whitelisted metadata, no justification/credential/provider payload copied into evidence.
- Legacy authority used: NO; feature operations do not change legacy tables/bridges or canonical Subjects/IdentityAccounts.
- PostgreSQL/RLS: PASS; real persisted runtime rows, no mocked database proof.
- Concurrent KEEP/REVOKE: exactly one successful decision and one success audit.
- Audit-failure rollback: PASS; deliberately rejected audit leaves Assignment ACTIVE and item PENDING.
- Stale changed/revoked/expired access: detected, never recreated; immutable snapshots cannot be rewritten.
- Real HTTP API/session certification: PASS; campaign configuration/create/list/detail/items, KEEP, REVOKE/replay, completion and audit, plus invalid scope/body/assignee/session denials.
- Existing resource authorization, SoD, security, provider contracts, identity and operational suites: PASS.
- TypeScript, lint, local production build, cutover readiness and git diff --check: PASS.

The full isolated runner passed existing regressions/build. The final Resources/Reviews replay passed after the HTTP assertion correction described below, including the final other-tenant reviewer and FK checks. GitHub CI remains a separate required gate on the pushed SHA; its exact SHA, immutable run URL and result are recorded on PR #13 rather than fabricated in this commit's self-referential report.

## Failed attempts retained

The expanded HTTP test initially expected one review item. Actual database inspection showed two real eligible grants: a direct RESOURCE grant and an existing TENANT-wide grant intersecting the same resource. A focused replay reproduced `expected=1, actual=2` at the assertion. The backend was correct and was not changed to discard the broad grant. The test now asserts both exact Entitlement IDs, KEEP of the broad grant, REVOKE of the direct grant, and completion only after both decisions. Final full Resources/Reviews replay passed. No assertion was bypassed and no synthetic evidence was produced.

The HTTP budget is explicitly bounded at 480 seconds for the expanded real-network-to-isolated-Postgres/locally compiled HTTP flow. Unit and PostgreSQL assertions are retained. The focused runner labels its HTTP-only result explicitly and does not claim skipped suites passed. Diagnostics publish only safe file/line and numeric assertion information, never raw database/HTTP output.

## Boundaries and cleanup

No business entitlement/assignment seed, production role elevation, legacy migration, provider call, PR #12 modification, merge or deployment. Reviews target resource-bound canonical grants, and REVOKE withdraws a whole Assignment, not a fabricated partial grant. Snapshot/request scope and immutable reviewer fields cannot be used as a provisioning path.

Existing resources/SoD databases and their proofs were not deleted. The isolated branch expires at 2026-10-06T12:00:00Z; cleanup is expiration of this clone and its fixture databases only, never the Production parent or Providers certification branch. Retain this report, PR evidence and CI run before expiration. Any Production rollout requires a separately approved migration/application/grant plan; rollback must not recreate revoked grants or destroy evidence.
