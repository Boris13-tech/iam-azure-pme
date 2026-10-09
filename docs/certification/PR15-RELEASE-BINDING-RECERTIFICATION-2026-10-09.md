# PR15 release-binding correction and recertification

## Purpose and authority

The operator authorized the safest decision before promotion. The original runner pinned the old deployment SHA in source, so promoting it and preparing a manifest for the resulting merge SHA would fail its own guard. This correction replaces that circular source pin with a separately registered immutable release artifact, bound to the exact manifest and detached human approval. It does not weaken the tenant, resource, environment or database guards.

The release artifact includes the exact Vercel project, Production deployment ID and deployed SHA. The Production entrypoint independently reads the Vercel control plane and requires those exact values, Production target and READY state. Approval binds both the manifest digest and release-artifact digest. A release change requires fresh registered bytes and detached operator approval. This is the existing trusted operator registration model, not a claim of cryptographic signature verification. The Production registry remains empty.

No browser approval, runtime entitlement, role name or environment SHA override supplies approval. Receipt replay also binds the release digest and deployment SHA. The abandoned October 8 manifest and IDs remain forbidden.

## Isolated recertification environment

- Project: `hidden-leaf-91460552`.
- Production parent: `br-billowing-frog-ahtirmax`, never mutated by this recertification.
- New clone: `br-crimson-credit-ahqddpia`, `pr15-release-binding-recertification-20261009`.
- Created: `2026-10-09T06:13:47Z`; expires: `2026-10-11T06:20:00Z`; parent LSN: `0/322B920`; resolved parent timestamp: `2026-10-09T06:11:56Z`; READY confirmed by the Neon control plane.
- Database `neondb`: exact-binding runner certification, with temporary grant revoked.
- Database `luxia_resources_diag_ci03`: fresh empty fixtures, 19 migrations, full CI-equivalent suite.
- Old owned clone `br-small-mountain-ahs8b0nr` was archived before deletion; export payload digest `09a962a7d0fc12ba62ea65c1fa300cf0fba27f9ac6a9a6eb130ae604d4e96412`. Reset was refused by the branch limit; only that owned temporary clone was replaced. Production, restoration branches and Providers certification were not deleted.

Credentials were sourced into process memory only. No connection strings, passwords, cookies or tokens are recorded here.

## Completed runner evidence

- Negative PostgreSQL/RLS runner: 5 tests PASS, 1 explicitly gated positive case skipped; 38.42 seconds. Inactive Subject, inactive binding and SoD conflict are refused with persisted canonical evidence and no assignment creation.
- Positive HTTP clone runner: 5 tests PASS, 1 explicitly gated negative fixture case skipped; 65.52 seconds. Initial DENY, exactly one bounded DIRECT RESOURCE assignment, ALLOW, exact replay, changed release refusal, revoke, DENY, revoked replay no recreation, cross-tenant denial and immutable evidence all asserted.
- Final hard-guard and diagnostic unit tests: 8 PASS, 2 gated database cases skipped; 3.16 seconds.
- Full CI-equivalent: 69 files PASS, 1 gated file skipped; 361 tests PASS, 11 gated cases skipped; 842.05 seconds. No timeout. The exact five CI test folders ran with one worker and the unchanged 120-second integration budget on fresh fixtures.
- Post-process cleanup: PASS at `2026-10-09T06:31:24.360Z`. The two clone databases have zero deadlocks, no advisory locks, no blocked sessions or open transactions. Two idle app_user pooled backends are expected server pool reuse, not leaked client transactions.
- Sampling capture was partial because one early tool-output chunk was truncated. The retained 56 samples contain no blocker; this is not an exhaustive-sampling claim. Completed assertions, final process exit and independent post-process SQL cleanup are the certification evidence.
- Final production build PASS (exit 0): TypeScript, lint, Prisma generation and Next production build. Existing unused-variable, next-lint deprecation and local multiple-lockfile warnings remain non-blocking; no unrelated cleanup was performed.
- Identity operational certification PASS (14 gates). Migration BOM gate PASS (19 files). `git diff --check` PASS. Cutover report PASS against the isolated CI database; its pipeline-precondition labels are not independent checks, and its concurrent-drift metric explicitly remains uninstrumented. The actual tests/build/migrations are recorded separately above.
- Staged-source secret-pattern scan and the pinned session-disposition digest were verified before publication. These new results do not retroactively replace the earlier candidate's evidence.

## Production read-only baseline

Observed SQL timestamp: `2026-10-09T06:23:54.099Z`. The entire inspection transaction explicitly set `READ ONLY` before establishing scope.

- Production deployment: `dpl_6dxDToNgg8V3ZZMQX9RerfuZZEZM`, READY, SHA `5704558f5c343ae653c8984917b90a760caeabf1`.
- Main remained that SHA; PR15 remained Draft at the original candidate during recertification.
- PR12 remained Draft at `d604a48fa62fbec65676c0423a08645805d67129` and is excluded.
- Runtime: `app_user`, database `neondb`, NOSUPERUSER, NOBYPASSRLS, controlled-table ownership count 0.
- All 12 inspected identity/resource/governance/audit tables: RLS enabled and forced.
- LUXIA PUBLIC function EXECUTE: none. Global creator default ACL: `neondb_owner`, namespace 0, owner-only EXECUTE; no default PUBLIC EXECUTE.
- Migrations: 19 applied, including Resource Onboarding; PR15 adds no migration.
- Subject ACTIVE; Resource/RESOURCE Scope/Entitlement exact binding: true; SoD decision ALLOW (no matching conflict); protected authorization DENY.
- Bootstrap assignment count: **0**; existing assignments: **21**.
- Subject count 1, IdentityAccount count 2, providers count 2, legacy users count 2, LegacyUserBridge count 0.
- Sessions: 59 total, one unexpired. The separately pinned October 8 attribution disposition remains unchanged; no session identifier was exposed.

Preservation digests from scoped read-only inspection:

| Table | Count | Digest |
| --- | ---: | --- |
| Subject | 1 | `457b5d60f12a6dfcefe1712016502d82` |
| IdentityAccount | 2 | `0714d38589d2ee4dc18a4da0bf7c98a0` |
| Assignment | 21 | `83e7540cab85667c96e63da4ba5f2183` |
| Resource | 1 | `6b36638b391a4bcb131522fe9c04cc5f` |
| ResourceScope | 1 | `d97dbb74b2967d1a40bb2d0b2978869a` |
| Entitlement | 22 | `ba34b454b1fbe0bbc37518a324d6d95c` |
| ProviderConnection | 2 | `5f02e7ab268625a8886d5c098f4f7998` |
| User | 2 | `d671e97936d6fa9c83440583538fd783` |
| Role | 3 | `ed87c63fa080c1bab69589d9f6db98ea` |
| Permission | 0 | `d41d8cd98f00b204e9800998ecf8427e` |
| UserRole | 2 | `e1de0551e3aa1ae80ac26b50097c794c` |
| AccessPolicy | 1 | `0a4930fd927a268c13a21aa2ee988272` |
| AuditLog | 2 | `147a8529946251b5854f1d05547f0431` |
| LegacyUserBridge | 0 | `d41d8cd98f00b204e9800998ecf8427e` |

No Production bootstrap, manifest registration, new Production manifest, deployment, business mutation or merge occurred while collecting this baseline. Promotion still requires all current candidate gates and exact merge-SHA CI. A fresh Production manifest will only be generated after the deployed release is certified, and will require fresh explicit human approval.

Rollback target for this code-only promotion is the current known-good deployment `dpl_6dxDToNgg8V3ZZMQX9RerfuZZEZM`. The existing database restoration branch `br-misty-scene-ahhdjk9z` is READY, parent Production, LSN `0/3042E68`, timestamp `2026-10-08T03:37:32Z`, expiry `2026-10-15T03:37:34Z`. It is a historical pre-PR14 restoration point, not a fresh copy of today's business state. PR15 has no database migration and requires no Production data write or destructive restore. Application rollback must not restore that older database unnecessarily.
