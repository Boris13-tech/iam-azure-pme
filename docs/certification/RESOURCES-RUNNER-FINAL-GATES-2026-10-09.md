# Resources timeout / dedicated operator runner — final local gates

Application baseline: 5704558f5c343ae653c8984917b90a760caeabf1 (identical application tree to PR14 head). Certification only: br-small-mountain-ahs8b0nr. Production, PR12 and manifests were not modified.

| Gate | Result / evidence |
| --- | --- |
| Resources suite | PASS — 80 tests with two workers; full final serial CI-equivalent includes all Resources cases |
| No timeout | PASS — affected case 24.8s, 34.8s, 22.2s and final 25.7s; no budget increase |
| No deadlock | PASS — independent samples and final seven-database counters: zero |
| No connection leak | PASS — clients disconnect; only idle server-pool backends remain |
| No transaction leak | PASS — final open transaction / advisory lock count zero |
| Runner clone certification | PASS — separately activated negative and real PostgreSQL/HTTP positive ceremonies |
| PostgreSQL/RLS | PASS — app_user NOSUPERUSER, NOBYPASSRLS, no ownership; cross-tenant DENY |
| Security | PASS — 105 security tests; same tests included in final suite |
| TypeScript | PASS — final production build includes tsc --noEmit |
| Build | PASS — npm run build; existing lint/deprecation/workspace warnings unchanged |
| CI-equivalent | PASS — 69 files, 360 tests, 11 explicit conditional skips; 931.06s |
| Identity operational report | PASS — 14 structural/evidence-reference gates; not live provider certification |
| Migration BOM / whitespace | PASS — 19 migrations and git diff --check |
| Cutover readiness | PASS — isolated app_user runtime; pipeline preconditions satisfied, reported concurrent drift remains explicitly uninstrumented |
| Real GitHub CI | Pending publication; authoritative result must be attached to the exact dedicated commit/PR, not inferred from local PASS |

Root cause evidence: Windows Modern Standby / Idle Timeout interrupted the historical execution for about 59 minutes. Historical SQL/last assertion were not captured and cannot be reconstructed conclusively. Current safe observers show bounded transactions and no SQL blocking. Test-only readiness and reversible idle-sleep prevention address this condition; business authorization, SoD, Reviews and onboarding code are unchanged.

Two rejected diagnostic invocations are retained as NOT PASS: reused legacy fixture database (P2002), and overbroad selector importing old root-level executable scripts outside GitHub CI. The final fresh-db harness checks empty fixtures and selects the actual five CI folders. It does not claim that the unrelated ad-hoc scripts are repaired or certified.

The dedicated runner remains operator-only, unreachable from application modules. Production registrations are empty. The abandoned manifest remains permanently forbidden. No new Production manifest or approval was generated. Clone positive ceremony left its exact bootstrap grant REVOKED and proved DENY after revoke and no recreation on replay.

Evidence: RESOURCES-FINAL-CI-EQUIVALENT-2026-10-09.json, RESOURCES-FINAL-CLEANUP-2026-10-09.json, RESOURCES-RUNNER-CERTIFICATION-2026-10-09.json, RESOURCES-SECURITY-CERTIFICATION-2026-10-09.json and RESOURCES-TIMEOUT-DIAGNOSIS-2026-10-09.md.

Cleanup: this isolated clone expires 2026-10-10T18:00:00Z. Preserve checked-in redacted evidence before deletion. Delete only br-small-mountain-ahs8b0nr after evidence retention/expiry; never its Production parent, Providers certification branch or restore points. No cleanup of Production identities, sessions or grants is authorized.

STOP before Production manifest generation, owner grant, deployment, merge or any new product slice.
