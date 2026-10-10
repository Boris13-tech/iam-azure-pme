# Operator browser evidence transport certification

Application/base SHA: e4038f89924c3e52e904a3578d086276ab890b72.
Work branch: fix/operator-browser-evidence. Operator changes are not deployed application changes.

Production is not mutated by this certification. The Production registration registry remains empty. The expired manifest is abandoned; its approval cannot authorize a replacement.

## Completed evidence

- Targeted Vitest run, 2026-10-09T17:15Z: 2 files passed, 10 tests passed, 2 gated clone tests skipped. This is not a substitute for PostgreSQL/HTTP clone certification.
- Prior isolated clone positive ceremony: 5 tests passed, 1 gated test skipped; actual HTTP DENY → exact bounded grant → ALLOW → revoke → DENY, persisted canonical evidence verification, replay/no-recreation and cross-tenant invisibility verified.
- Prior isolated clone negative certification: 5 tests passed, 1 gated test skipped; Subject, resource binding and SoD refusal checks exercised on the clone.
- npm run build: exit 0 on 2026-10-09; TypeScript, lint and production build passed. Existing lint/workspace-root warnings remain; no unrelated code is modified to suppress them.
- git diff --check: exit 0.

## Full-suite recertification

The prior terminal result was unavailable after resumption. No PASS is inferred from process disappearance or partial output.

A new empty database luxia_resources_diag_ci04 was created only on br-misty-sun-ahs4b46j. Schema preparation succeeded, 19 migrations applied, and the empty-fixture gate passed. Full suite started at 2026-10-09T17:18:35.1041120Z with one worker and unchanged test/hook timeouts. Machine-readable results are written by Vitest to operator-ci-luxia_resources_diag_ci04-results.json.

Full-suite attempt completed: 68 files passed, 2 suite setup failures, 1 gated file skipped; 348 tests passed, 30 skipped. The SoD and Access Review setup guards rejected ci04 because their explicit clone database allowlists had not been updated. No business authorization assertion failed in that attempt. Both literal clone-only allowlists were corrected, preserving Production denial.

The first targeted rerun inadvertently omitted the existing harness's 120-second test/hook options and therefore failed against Vitest's 5-second/10-second defaults. Its report is preserved separately, not overwritten. A corrected rerun uses the pre-existing 120-second settings, with no global timeout increase. Do not infer PASS until its actual assertions and SQL cleanup pass.

Final SQL cleanup and GitHub CI remain PENDING. No Production end-to-end PASS is claimed. (Historical at the time of writing; both are resolved below.)

The corrected targeted rerun completed with SoD fully passing and 18/19 tests passing overall. The remaining Access Review case failed with Prisma P1017 (server closed the connection). Windows System events record Modern Standby entry at local 20:36:16 and exit at 20:36:58 (UTC 17:36:16–17:36:58), overlapping the failed 44.746-second case. That standalone rerun did not use the existing thread-scoped anti-standby harness. Do not change business code or silently retry mutations to hide this environmental interruption.

A final full-suite run uses a new empty clone database luxia_resources_diag_ci05 and the existing harness's reversible execution-state guard and original 120-second settings. Its result must be recorded independently; previous failed reports remain preserved.

## Final isolated suite result

The ci05 execution completed with exit 0: 70 files passed, 1 gated file skipped; 367 tests passed, 11 gated tests skipped, 0 failed. Duration 860.38 seconds. The standby guard was restored. The skipped cases are not claimed as live provider or Production certification.

Local machine-readable report SHA-256: e4ee2bb6c9963d74d78d17cd9bb68f40897295299d7325e53e115668edefa838. Raw local test reports, including unsuccessful attempts, are retained locally; this non-secret summary is the review artifact.

Read-only cleanup at 2026-10-09T17:55:59.403Z passed: no advisory locks, blocked backends or open transactions; all inspected database deadlock counters were zero. Two idle app_user pool backends are expected server-pool reuse, not leaked transactions. app_user is NOSUPERUSER/NOBYPASSRLS and owns no public relations.

TypeScript and the 14 Identity v1 operational gates passed. The final build repeat completed with exit 0 after final fixture guard changes. GitHub CI on the operator commit: see "GitHub CI" below. The Production ceremony remains unexecuted.

## Security boundary

Stdin carries only a bounded probe/status/evidence response. Detached human approval remains independently registered and digest-bound. Fresh exact tenant/actor/resource/action and approved Assignment evidence are required from the canonical database; claimed HTTP status alone cannot pass. No cookie export, new authenticated Session, browser approval API, admin bypass or business authorization change is introduced.

## GitHub CI

Observed 2026-10-10: GitHub CI `test-and-build` PASS on operator commit f22d8563e8cb7c5bc0bcf5dda7cda374e17fa76c (run https://github.com/Boris13-tech/iam-azure-pme/actions/runs/37969954967); Vercel Preview PASS. The Production activation/identity jobs were skipped as designed for pull requests. This is CI evidence only, not Production certification. CI on later commits of this branch is recorded on the pull request.
