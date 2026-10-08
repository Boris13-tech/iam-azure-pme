# Resource Access Onboarding v1 — pre-bootstrap evidence

Status: **PARTIAL / FIRST-OWNER APPROVAL BLOCKED**, not full onboarding certification.
Baseline main: `023814e9d6a9e97122150999c0ef9d692413e03c`.
Branch: `feat/resource-access-onboarding-v1`.

## Implemented, with zero initial access grants

- Real `GET /api/resources/protected-resource-demo`, authenticated canonical session,
  fixed server Resource/action, exact RESOURCE binding and native evaluation.
- Tenant-bound, server-issued onboarding plan; atomic Resource/Scope/Entitlement
  configuration; same-operation replay and concurrency produce no duplicate effects.
- Existing canonical Subject selection, bounded proposed expiry and backend SoD preview.
- Server-enforced `delegation = BLOCKED`; no bootstrap executor or browser approval flag.
- Committed DENY evidence, including self-grant and invalid broadening requests.
- Append-only proof guard for new RESOURCE.ONBOARDING/RESOURCE.CAPABILITY events only.
- UI consumes real APIs and distinguishes configuration from effective access.

## Actual isolated PostgreSQL/HTTP evidence

Neon project `hidden-leaf-91460552`, clone `br-flat-dream-ahgvk9x6` of Production,
parent LSN `0/3013340`, database `neondb`, expires `2026-10-10T12:00:00Z`.
Endpoint `ep-delicate-bar-ahz7cosb`; runtime `app_user`; no owner used for API tests.
The copied real canonical Subject is used; no new Subject or IdentityAccount is made.

Final focused run: **8/8 PASS**, including real session/HTTP; prior focused retry:
7 PASS / HTTP skipped explicitly. Unit/architecture: 12/12 PASS; combined targeted
resource authorization/function architecture: 25 PASS, 1 PostgreSQL-only gate skipped
in that unit invocation. TypeScript and lint passed (existing lint warnings remain).

- app_user NOSUPERUSER, NOBYPASSRLS, no public-table ownership: PASS.
- Existing Resource/Scope/Entitlement/Assignment/Audit RLS enabled/forced: PASS.
- New trigger PUBLIC EXECUTE = NO, app_user EXECUTE = NO; triggers still enforce: PASS.
- Exactly one Resource, RESOURCE Scope, Entitlement; new scoped Assignments = **0**.
- Two concurrent confirmations + replay: one configuration effect and one apply audit.
- Self-elevation request + replay: DENY, one committed DENIED event.
- HTTP client Subject/tenant/Resource/action query claims ignored; actual server DENY.
- Fake browser approval field rejected and audited; no grant persisted.
- Cross-tenant RLS reads invisible and cross-context Resource write rejected.
- Receipt UPDATE/DELETE rejected; evidence remains readable in the correct tenant.
- Revoking the certification session makes the protected route HTTP 401.
- Subject/IdentityAccount/existing Assignment and legacy table digests unchanged.
- No sensitive metadata keys or certification-session token in captured server output.

Only the evidence migration is applied on the clone; **Production is untouched**.
Certification sessions are created/revoked in the clone only, never existing Production
sessions. No provider API is called. PR12 remains Draft at its frozen SHA.

## Regression attempts — preserve failures, do not manufacture PASS

Resources/SoD/Access Reviews PostgreSQL regression passed on the existing isolated
`luxia_reviews_cert` database. Its subsequent security suite failed with unique/FK
errors (dual-write/global-role/backfill fixtures). Those suites use fixed permission
keys and other leftover fixture names; a reused fixture database is not a clean CI DB.
No business code was altered to suppress these failures. A fresh `luxia_resources_cert`
database was created on the isolated `br-steep-morning-ahsjmlye` branch for a clean
CI-equivalent rerun. Its result must be recorded separately when it finishes.

An unrestricted Vitest run without DB injection also failed: missing DATABASE_URL /
DATABASE_MIGRATION_URL and two pre-existing standalone scripts discovered as tests.
It is not claimed as PASS. The declared GitHub CI suites are the regression gate.
GitHub CI/build status must be obtained from the candidate SHA, not inferred here.

## Requested full exit gate

| Gate | State / exact limitation |
|---|---|
| Real protected server capability | PASS for actual HTTP DENY and trusted server binding |
| Canonical Resource binding | PASS on clone |
| RESOURCE scope enforcement | PASS on clone + unit broadened-scope rejection |
| First-owner bootstrap safety | BLOCKED: design exists, not approved/implemented/certified |
| No implicit elevation | PASS: zero new access grants; management is not access authority |
| Assignment authority | Existing protections unchanged; first owner/delegation BLOCKED |
| SoD preserved | Existing resource/SoD/review PostgreSQL regression PASS |
| Idempotency | Configuration and controlled DENY PASS; owner/grant sequence not certified |
| Revocation causes real server DENY | NOT CERTIFIED for a Resource grant; no unapproved grant inserted |
| Refusal audit persistence | PASS for tested missing grant/self-elevation/invalid request paths |
| Cross-tenant | DENY in isolated RLS and server-bound claim tests |
| Existing identity/legacy preservation | PASS for copied real identity and original grants |
| PostgreSQL/RLS | PASS for first slice, 8 actual clone tests |
| Build / full tests / CI | Require candidate-SHA results; see separate CI evidence |

The real `DENY → approved owner grant → ALLOW → revoke → DENY` sequence is **NOT
executed**. Expired/revoked first-owner grant and bootstrap replay/broadening gates
remain pending the separate approved executor, rather than being simulated.

Bootstrap design: `docs/architecture/RESOURCE-ACCESS-ONBOARDING-V1-CAPABILITY.md`.
No merge, Production deployment, first-owner Assignment or generic policy engine.
Clone expiration is the cleanup boundary; preserve non-secret evidence before it.
