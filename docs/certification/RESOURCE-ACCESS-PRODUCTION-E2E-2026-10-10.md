# RESOURCE ACCESS ONBOARDING V1 — PRODUCTION END-TO-END CERTIFICATION: PASS

Date: 2026-10-10. Environment: PRODUCTION (Neon `hidden-leaf-91460552` / `br-billowing-frog-ahtirmax`, database `neondb`, role `app_user`).
Deployment: Vercel `dpl_J3GnuWwpMFejURjG5ASKWc8nJK5U`, SHA `8acea18fae902aad1d444db3b21eef721b4e0760` (READY, verified via the Vercel API before generation and by the runner's own control-plane check).
Machine-readable evidence: `RESOURCE-ACCESS-PRODUCTION-E2E-2026-10-10.json`. It contains the exact manifest/release bytes, the approval, the runner transcript, and the post-verification. It contains no secret.

## Manifest and approval

| Item | Value |
|---|---|
| Manifest binding | `e2db955070cc09ee6b69fe10774ce62b78839f90dad9628f6794946ee339ee2b` |
| Release binding | `2219c78e6419d665542df7af8f1cebd2f2f9ece37f551ad83a83d134451aaf70` |
| Assignment / operation | `abea167e-16dd-4fdd-87a2-30ae0f8c1041` / `d10049e4-0f2a-4d89-ba7c-0b6dee7998f2` |
| Target | Subject `30a15eda-…`, Resource `ed8c9111-…`, Scope `3952f920-…` (RESOURCE), Entitlement `d6605f22-…`, action `resource.read`, DIRECT |
| Validity window | 2026-10-10T15:34:00Z → 16:34:00Z (1 h) |
| Human approval | explicit chat message "J'approuve le manifeste e2db9550", observed 2026-10-10T15:39:33Z |

The registry entry was made only in the operator's local checkout and emptied immediately after the run. It was never committed. `main` keeps `PRODUCTION_REGISTRATIONS` empty.

## Pre-conditions (read-only, 2026-10-10T15:34:03Z)

Preflight PASS: app_user NOSUPERUSER/NOBYPASSRLS/no ownership, RLS forced on 12 tables, no PUBLIC EXECUTE, Subject ACTIVE, exact binding, SoD no conflict, bootstrap Assignment count 0, protected capability DENY. Assignment table: 21 rows, digest `83e7540cab85667c96e63da4ba5f2183`.

## Ceremony (unmodified `scripts/operators/run-production-resource-bootstrap.ts --browser-evidence`)

The browser evidence came from the operator's authenticated Chrome session, read through the Claude in Chrome extension. Only the fixed GET route was read; no cookie was read or exported. Each probe was verified by the runner against the persisted canonical audit event (exact org/tenant/actor/resource/action/result/assignment, fresh, not reused).

| Step | Evidence | Result |
|---|---|---|
| Initial protected read | `1225d30a-473e-46d5-8077-8b103b8d257a` | 403 DENY, verified |
| Grant (exactly one bounded DIRECT RESOURCE Assignment) | audit `bootstrap:d10049e4…` RESOURCE.ONBOARDING.BOOTSTRAP SUCCESS at 15:40:42.212Z | CREATED |
| Protected read with grant | `4fb39915-37f0-49aa-984f-c0cbcdf7121c` | 200 ALLOW, assignmentIds = [`abea167e…`] |
| Exact replay | runner check | ALREADY_APPLIED (idempotent, no new row) |
| Modified replay (bytes + `\n`) | runner `validate()` | refused before any SQL |
| Revoke | audit `…:revoke` RESOURCE.ONBOARDING.BOOTSTRAP.REVOKE SUCCESS at 15:41:16.317Z | REVOKED |
| Protected read after revoke | `5279d6a8-d369-49b5-8102-13fc1117a27a` | 403 DENY, verified |
| Cross-tenant visibility of the Assignment | runner check | 0 |
| Revoked replay | audit `…:denied:BOOTSTRAP_ALREADY_REVOKED_OR_CONFLICTING` at 15:41:37.814Z | DENIED, no recreation |

Runner output: `{"manifestBinding":"e2db9550…","before":"1225d30a…","allowed":"4fb39915…","denied":"5279d6a8…","grant":"REVOKED","result":"PASS"}`. Exit code 0 at 15:41:40.728Z.

## Post-verification (read-only, 2026-10-10T15:42:51Z)

- The target entitlement has exactly **one** Assignment, `abea167e…`: status **REVOKED**, DIRECT, sourceRef `bootstrap:d10049e4…`, window 15:34–16:34Z. **0 ACTIVE.**
- The 21 other Assignments are **unchanged** (digest `83e7540cab85667c96e63da4ba5f2183`, identical to the pre-ceremony baseline). No parasitic mutation.
- Audit trail: BOOTSTRAP SUCCESS → REVOKE SUCCESS → BOOTSTRAP.DENIED (revoked replay).
- Protected authorization decision: **DENY**.

## Abandoned attempt (same day, no effect)

Manifest `7d1d9a7d59455e2cf9a0506a412daca598078a01a33cc7ca400c746355707451` (assignment `001b95ec-…`, operation `f802788d-…`) was approved at 11:51:41Z. It expired unused at 12:49:00Z. Two runner starts stopped at the initial DENY probe (browser not authenticated, probe timeout) before any grant. A read-only preflight at 14:34:01Z proved bootstrap count 0 and an unchanged Assignment digest. It must never be reused.

## Expected side effects

New Session rows (operator logins) and `RESOURCE.CAPABILITY.READ` audit events for each protected read. No other business data changed.

## Conclusion

DENY → exactly one bounded DIRECT grant → ALLOW → exact replay idempotent → modified replay DENY → revoke → DENY → revoked replay does not recreate: **PASS**, with no parasitic mutation.

**RESOURCE ACCESS ONBOARDING V1 — PRODUCTION END-TO-END CERTIFICATION: PASS**
