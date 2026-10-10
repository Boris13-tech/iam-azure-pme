# LUXIA Identity — Security Journal v1: scope proposal

Status: **PROPOSAL, awaiting operator validation.** No code, migration or Production change is part of this document.
Baseline: `main` @ `278a639`, Production `dpl_PCZz9eeMFHWjqpUtFZxQ5UdXi7sU`.

## 1. Why now (priority decision)

This slice comes before Customer Self-Onboarding because:
- self-onboarding, first admin / break-glass and access requests all need provable sign-in history;
- an IAM product must record sign-ins;
- it is the "Security Activity" block of the operator roadmap (Phase 1).

It is small and needs no migration.

## 2. Observed state (Production, 2026-10-10, read-only)

| What | Recorded today? | Where |
|---|---|---|
| Administrative actions (grant, revoke, configure…) | yes (8 events) | `CanonicalAdminAuditEvent` |
| Page consultations | yes (110 events) | `CanonicalAdminAuditEvent` (`*.READ`) |
| **Microsoft Entra sign-in (success)** | **no** | only a `Session` row is created (`app/auth/callback/route.ts`) |
| **Entra sign-in refused after identity resolution** (subject not active, environment mismatch) | **no** | HTTP 403 only |
| Passkey sign-in (success) | yes (13 in 7 days) | `AuthenticationEvidence` (`app/api/auth/local/complete/route.ts`) |
| **Passkey sign-in refused for a known identity** (subject not active) | **no** | HTTP 401 only |
| **Sign-out** | **no** | the session is revoked silently (`app/auth/logout/route.ts`) |
| **Passkey enrolled** | **no** | not audited |
| Session expiry | implicit | `Session.expiresAt` (24 h) |

The "Journal d'audit" page therefore shows only 8 lines. Sign-ins and sign-outs are invisible.

## 3. Scope

### 3.1 Writes (record what really happens)

| # | Event | Where | Record | Failure behaviour |
|---|---|---|---|---|
| W1 | Entra sign-in success | `app/auth/callback/route.ts`, before session creation | `AuthenticationEvidence`: method `FEDERATED_OIDC`, outcome `VERIFIED`, source `EXTERNAL_PROVIDER`, userVerification `PROVIDER_ASSERTED`, `phishingResistant=false`, `hardwareBound=false`, assurance level per decision S1, reasonCode `ENTRA_OIDC_VERIFIED`, fresh `operationId` | **fail closed**: no evidence means no session (same as the passkey flow) |
| W2 | Entra sign-in refused after identity resolution | same route, `SessionCreationDeniedError` / environment mismatch | `AuthenticationEvidence` outcome `REJECTED`, reasonCode = the safe refusal code | the refusal stands even if the write fails (never turns into a success) |
| W3 | Passkey sign-in refused for a known identity | `app/api/auth/local/complete/route.ts` | `AuthenticationEvidence` `REJECTED`, reasonCode `SUBJECT_NOT_ACTIVE` | same as W2 |
| W4 | Sign-out | `app/auth/logout/route.ts` | `CanonicalAdminAuditEvent` `SESSION.SIGN_OUT` (actor = target = the subject) | sign-out always completes; a failed write is logged with a safe code |
| W5 | Passkey enrolled | `app/api/auth/local/enrollment/complete/route.ts` | `CanonicalAdminAuditEvent` `LOCAL_AUTHENTICATOR.ENROLL` (no credential material) | same transaction as the enrolment |

Never stored: ID tokens, raw claims, session tokens or hashes, IP or user-agent, credential material.

### 3.2 Reads

| # | Feature | Source | Permission |
|---|---|---|---|
| R1 | **Unified security journal**: the "Journal d'audit" page also shows sign-ins (success and refusal, method, assurance), sign-outs and enrolments. Consultations stay hidden by default. | new `GET /api/canonical/security-journal`: server-side merge of `CanonicalAdminAuditEvent` and `AuthenticationEvidence`, cursor pagination `(occurredAt, id)`, consultation audited as `AUDIT.READ` | `audit.read` |
| R2 | **"Mes sessions"** on the Authentification page: my active sessions (opened, last seen, expiry, method, "this session"), with a **Révoquer** button per session | new `GET /api/me/sessions`, `POST /api/me/sessions/{id}/revoke` (own sessions only, audited `SESSION.REVOKE`) | authenticated ACTIVE subject; own data only |
| R3 | **"Mes clés d'accès"**: my passkeys (type, status, enrolled, last used), view only in v1 (decision S2) | new `GET /api/me/authenticators` (no credential id, public key or counter) | authenticated ACTIVE subject; own data only |
| R4 | Dashboard: "Connexions (24 h) par méthode" and "Connexions refusées (24 h)" widgets. `auth.entraSignInEvidence` switches from `unavailable` to real counts **from the W1 deployment date onward** (labelled as such, no backfill or estimate). | `AuthenticationEvidence` | `audit.read` |

### 3.3 Out of scope (v1)

- **Failures before identity resolution** (unknown Entra account, invalid token, bad passkey signature) cannot be attached to a subject. Recording them needs a new anonymous, rate-limited table, which is a migration. Proposed as a later slice (S3).
- MFA / Conditional Access from Entra (requires exposing `amr` from the adapter and Microsoft Graph, which belongs with PR12).
- Revoking one's own passkey (S2), admin views of other users' sessions or passkeys, alerting and notifications.

## 4. Security invariants kept

- Tenant RLS on every read and write.
- Default deny.
- Sign-in fails closed if its evidence cannot be written (W1).
- Self-service endpoints filter on `auth.subjectId` under RLS and return 404 for anything not owned.
- Every privileged action stays audited, with idempotent revocation.
- No migration, no catalog or role change, no PR12 change.

## 5. Decisions requested

| # | Question | Recommendation |
|---|---|---|
| S1 | Assurance level recorded for Entra sign-ins | **`LOW` with userVerification `PROVIDER_ASSERTED`** until the adapter exposes `amr`. We do not claim MFA we cannot prove. |
| S2 | Passkeys in "Mes clés d'accès" | **View only in v1.** Revocation comes later, with a guard against locking oneself out. |
| S3 | Failures before identity resolution | **Not recorded in v1** (needs a migration). Listed as a known limitation. |
| S4 | Journal default | **Consultations hidden**, with the "Afficher les consultations" option kept |

## 6. Order and complexity

| Step | Content | Complexity |
|---|---|---|
| 1 | W1–W5 writes, unit and PostgreSQL tests (fail-closed W1, REJECTED W2/W3, no secrets stored) | M |
| 2 | R1 unified journal endpoint and page | M |
| 3 | R2/R3 self-service sessions and passkeys | M |
| 4 | R4 dashboard widgets | S |
| 5 | Certification: CI, Production deploy (approval), real Entra and passkey sign-in and sign-out, journal shows each, DB cross-check | M |

## 7. Acceptance criteria

1. A real Entra sign-in and a real passkey sign-in each produce exactly one `VERIFIED` evidence, visible in the journal with the right method.
2. A sign-in refused for a known but non-active identity produces one `REJECTED` evidence. No session is created.
3. If the W1 evidence write fails, no session is created (tested).
4. Sign-out produces `SESSION.SIGN_OUT`. Self-revocation produces `SESSION.REVOKE`. A user cannot see or revoke another user's session (tested under RLS).
5. Journal pagination is stable and ordered. It is tenant-isolated. Consultations are hidden by default.
6. Nothing sensitive appears in the payloads: no tokens, hashes, IP or user-agent, or credential material (tested).
7. Dashboard Entra counts start at the deployment date and are labelled as such.
8. CI PASS on exact SHAs. Production certified with an independent read-only DB cross-check.
