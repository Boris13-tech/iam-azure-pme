# LUXIA time convention: map, convention and convergence plan

Status: **proposal** (2026-10-12). It was asked for after the B4 finding: the break-glass event used the operator machine's clock, about 180 ms behind the database. The direction is approved by the operator. This document plans the convergence and changes nothing by itself.

Goal: every proof carries a time that is consistent, explainable and comparable, ready for LUXIA Trust Ledger.

## 1. Map of time sources (repository at `ec9ee2e`)

| Source | Where | Examples | Risk |
|---|---|---|---|
| **Prisma client default** (`@default(now())`, `@updatedAt`) | 45 `@default(now())` and 23 `@updatedAt` fields. Prisma fills them in the application process, with the server clock | `CanonicalAdminAuditEvent.occurredAt` (every application event), `AuthenticationEvidence.recordedAt`, `Session.createdAt`, `LocalRecoveryCode.createdAt`, `Organization.createdAt` | The application server's clock is NTP-synced but is not the database clock. Two clocks meet in one audit trail |
| **Application clock written explicitly** (`new Date()` passed into a write) | `lib`: `revokedAt` (11 places), `occurredAt` of sign-in evidence (6), `verifiedAt`, `usedAt`, `disabledAt`, `acceptedAt`, `lastSeenAt` and others | Session revocation by self-service, recovery-code use, sign-in evidence, `Session.expiresAt` = now + 24 h | The same as above. Expiry is also checked in the application (`expiresAt < new Date()`) |
| **Database clock** (`now()` in triggers and SQL) | 11 functions use it: `luxia_invitation_guard`, `luxia_organization_status_guard`, `luxia_session_guard`, `luxia_rate_limit_hit`, the signup-code functions, `luxia_sod_assignment_guard` and others. Also explicit `(now() AT TIME ZONE 'UTC')` in `transitionOrganization` and, since PR #50, the B4 event time | `Organization.statusChangedAt`, `Invitation.createdAt`/`expiresAt` (set by the guard), revocations by an organization transition, the B4 event | The authoritative clock, but used for only part of the data |
| **Database column default** (`DEFAULT CURRENT_TIMESTAMP` on `TIMESTAMP(3)`) | 33 `createdAt` and about 15 other columns | Used only when a row is inserted by raw SQL without the value | `CURRENT_TIMESTAMP` is converted with the session `TimeZone`. It is UTC today (Neon default; ASSUMPTION, not enforced). A session in another time zone would store a local time |
| **Operator workstation** | The B4 command: plan `issuedAt` and `notAfter`, and `now` used by `REVOKE_SESSIONS` (`revokedAt`) and `DISABLE_ACCOUNT` (`disabledAt`, `revokedAt`) | B4 rows written by those two actions | **Open finding:** the event of the same transaction now uses database time, but those rows still use the workstation's clock |
| **External providers** | Not used. Entra's `auth_time` and `iat` are not kept; `authenticatedAt` is the application time at the callback | Entra sign-in evidence | No second witness of when the provider authenticated the person |
| **Browser** | Never trusted for time | | None |

All stored instants are UTC with millisecond precision (`TIMESTAMP(3)` without time zone).

## 2. Proposed convention (LUXIA time convention v1)

1. **One authority:** the database transaction time, `(now() AT TIME ZONE 'UTC')::timestamp(3)`, is the time of every state change and of the audit event that records it.
2. **One instant per transaction:** every row the transaction changes and its audit event carry the same instant. A reader can join them by time as well as by `changeId`.
3. **Witnesses, never authorities:**
   - the application's observation time (`observedAt`) and a provider's asserted time (`assertedAt`, for example Entra `auth_time`) may be stored next to the authoritative time, to explain a sequence;
   - they are never used to order, expire or decide.
4. **Decide with the clock that set the value:** an expiry set from database time is checked against database time. The application compares only values it set itself.
5. **Workstation time is never written.** Operator tools use it only for local UX, such as plan validity.
6. **Ordering for proofs:** within a tenant, order by `(occurredAt, id)` today. For Trust Ledger, order by a monotonic sequence number with a hash chain, so ordering never depends on a clock.
7. **UTC everywhere**, never depending on a session `TimeZone`.

## 3. Convergence plan (by value and risk)

| Phase | Change | Risk | Value |
|---|---|---|---|
| 0, done | B4 event time from the database (PR #50), proven in Production: event time equals `statusChangedAt` | | |
| 1, next, no migration | B4 `perform` uses the same database instant for `revokedAt` and `disabledAt`; one helper reads it once per transaction | Low: the operator tool only | Closes the open B4 finding |
| 2, no migration | The journal writers (`operation()` in `lib/resources/service.ts` and the dedicated writers in onboarding, recovery, self-service and sign-in evidence) take the database instant through the same helper, and pass it to the rows they write. One extra round trip per write, inside the existing transaction | Low to medium: many writers, each covered by tests | Every audit event and its rows share one clock |
| 3, migration (default only, reversible) | `occurredAt` and `recordedAt` of the journal and the evidence default to `(now() AT TIME ZONE 'UTC')` in the database (`@default(dbgenerated(...))`), and the application stops sending them. Same for the 33 `CURRENT_TIMESTAMP` defaults: explicit UTC, no dependence on `TimeZone` | Low: column defaults only, rehearsed on a clone | Removes the second clock structurally |
| 4, migration | Witness columns: `observedAt`, and `assertedAt` for providers (Entra `auth_time`) | Low | Explains sequences; useful evidence for customers |
| 5, Trust Ledger | Per-tenant monotonic sequence and hash chain over audit events. Time is an attribute, not the order | Design first | Tamper-evident, comparable proofs |

**Not now:** a single global migration of every timestamp. It brings more risk than value. Phases 1 to 3 remove the mixed clocks from the audit trail, which is where it matters.

Every phase follows the usual path:
- tests that compare the event time with the time set by the database in the same transaction;
- CI;
- a clone rehearsal for phases 3 and 4;
- a read-only check in Production.
