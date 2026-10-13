# Enterprise readiness gate: what prevents a real company from trusting LUXIA with its identities

A **gate**, not a note. Started 2026-10-12, after First Admin / Break-glass v1 (B1 to B5 in Production). It separates **working** from **ready for a company**.

**Status of each requirement:**

| Status | Meaning |
|---|---|
| `UNKNOWN` | Not designed |
| `DESIGNED` | A reviewed design exists |
| `IMPLEMENTED` | Merged on `main` with tests |
| `VERIFIED` | Proven by CI and a rehearsal |
| `PRODUCTION VERIFIED` | Proven in Production with read-only evidence |

A merged PR alone never makes a requirement done. Evidence is labelled VERIFIED (observed) or ASSUMPTION (to be confirmed). Priorities are P0 to P4. Updated at each release.

## Decisions recorded (operator, 2026-10-13)

- **Region:**
  - the default Production region for LUXIA is the European Union, Frankfurt unless a technical or commercial reason says otherwise;
  - the current US East environment may stay during development;
  - the move happens before any real commercial beta, as a rehearsed platform operation.
  - In the long term, data residency becomes a property of the deployment and of the tenant, never a single-region architecture.
- **Paid plans:** the smallest serious commercial tier that meets explicit backup, retention, monitoring and operating requirements. The costs are documented: minimum monthly, and at 10, 100 and 1,000 organizations. No upgrade without a requirement it resolves.
- **Independent backups:**
  - object storage in the EU, outside the Neon project and ideally outside the same account and failure domain;
  - versioning or object lock where available;
  - encrypted with a key LUXIA controls.
  - The operator's workstation is not a backup destination; local Docker is allowed only for temporary, controlled restore drills.
- **Legal basis:** drafts start now, marked `DRAFT — LEGAL REVIEW REQUIRED`. No compliance claim that has not been demonstrated.

## Requirements before a paying private beta

| # | Requirement (blocker today) | Evidence | LUXIA fit | Priority | Status |
|---|---|---|---|---|---|
| E1 | **Prove that LUXIA comes back after losing its database.** Today there is no backup outside the Neon project, history covers 6 hours, and no restore was ever tested | `docs/operations/BACKUP-RESTORE-PLAN.md` (VERIFIED) | Runtime / operations | **P1** | `DESIGNED`: inventory, policy, and the independent backup architecture (`docs/operations/INDEPENDENT-BACKUP-ARCHITECTURE.md`); waiting for the storage account, the key and the backup role |
| E2 | **The audit trail is append-only for application and ordinary operator roles.** Until 2026-10-13 the application role could update or delete journal rows (except resource onboarding) and every sign-in evidence row. Not cryptographic immutability (Trust Ledger) | `docs/certification/T0-AUDIT-APPEND-ONLY-RELEASE-2026-10-13.md` | Identity, then Trust Ledger | **P1** | `PRODUCTION VERIFIED` (T0, 2026-10-13: real UPDATE and DELETE refused for `app_user` and the owner) |
| E3 | **Commercial-grade hosting in the EU.** Today: Neon Free and Vercel Hobby, both in US East, no service commitment. Vercel: « Our Hobby plan is for personal, non-commercial use » (VERIFIED, pricing page) | Inventory (VERIFIED) | Runtime / business | **P1** | `DESIGNED` (`docs/operations/HOSTING-EU-AND-COSTS.md`); waiting for the spending decision |
| E4 | **Observability.** Today there is no error tracking, alerting, uptime check, status page or logging library; LUXIA would learn about an outage from a customer | `package.json` (VERIFIED) | Runtime / observability | **P1** | `UNKNOWN` |
| E5 | **Privacy and legal basis:** privacy policy, data processing agreement, subprocessors (Neon, Vercel, Microsoft), retention and deletion, data subject requests, breach notification, data residency | `docs/legal/` (drafts, 2026-10-13) | Business / legal | **P1** | `DESIGNED`: 8 technical drafts, all marked `DRAFT — LEGAL REVIEW REQUIRED`; counsel, the legal entity and the decisions marked `[TO BE DECIDED]` are missing |
| E6 | **Notification channel**, provider-neutral (`Notification → Channel Adapter`). Today there is no e-mail; invitations are links copied by hand; administrators are not told about sensitive events | `package.json` (VERIFIED) | Platform component | P2 | `DESIGNED` (contract only: `docs/architecture/NOTIFICATION-CONTRACT.md`) |
| E7 | **More than one operator and one workstation.** Today every Production operation runs from one Windows machine | `docs/handoff/CURRENT-STATE.md` section 10 (VERIFIED) | Operations | P2 | `UNKNOWN` |
| E8 | **Incident response:** runbook, on-call, customer communication | `docs/legal/INCIDENT-RESPONSE-AND-BREACH-NOTIFICATION.md` (draft) | Operations | P2 | `DESIGNED` (draft procedure; no on-call, no practice run) |
| E9 | **Export** of identities, accesses and journal, for the customer's audits and portability | `app/api` (VERIFIED, none) | Identity / Trust Ledger | P2 | `UNKNOWN` |
| E10 | **External penetration test** | ASSUMPTION (none on record) | Security | P2 before GA, P3 before beta | `UNKNOWN` |
| E11 | **Administrators can revoke a person's passkey** (known limit S2) | `docs/handoff/CURRENT-STATE.md` (VERIFIED) | Identity | P2 | `UNKNOWN` |
| E12 | **Microsoft sign-ins:** proof of MFA and the provider's own authentication time | `docs/architecture/LUXIA-TIME-CONVENTION.md` (VERIFIED, both missing) | Identity / Adapters | P3 | `UNKNOWN` |
| E13 | **More providers:** Google, generic OIDC, SAML, SCIM | PR #12 (stale, not merged) | Adapters | P3 (expansion) | `DESIGNED` (stale PR) |
| E14 | **Explicit security policies** instead of rules in code | Architecture | Policy | P3 | `UNKNOWN` |
| E15 | **Network identifiers are minimized.** Today every session keeps an **unsalted** SHA-256 of the IP address and of the user agent, with no limit. An IPv4 address can be recovered from such a hash by trial, so these are personal data. The abuse counters keep the same kind of hash for 2 days | `lib/auth/session-store.ts`, `lib/security/rate-limit.ts` (VERIFIED) | Identity / privacy | P2 | `UNKNOWN`. Proposal: a keyed hash (HMAC with a LUXIA secret) or a truncated address, and removal 30 days after the session ends |
| E16 | **Retention and deletion are enforced.** Today sessions, challenges, Microsoft sign-in transactions, the journal and the sign-in records are kept with no limit, and a closed organization is never deleted | `docs/legal/DATA-RETENTION-AND-DELETION.md` section 1 (VERIFIED) | Identity / privacy | P1 before a commercial beta | `DESIGNED` (proposal; periods to decide with counsel) |

## Already in place

| Capability | Status |
|---|---|
| Forced row-level security per tenant; `app_user` NOSUPERUSER and NOBYPASSRLS; certified across organizations | `PRODUCTION VERIFIED` |
| Phishing-resistant sign-in (passkeys), recovery codes and a recovery-only session (B2) | `PRODUCTION VERIFIED` |
| No organization can lose its last administrator (B1); organization status enforced at sign-in and session level (B3) | `PRODUCTION VERIFIED` |
| Operator actions only through a closed, planned, digested, journaled procedure (B4), labelled for the customer (B5) | `PRODUCTION VERIFIED` |
| Every release certified in Production with read-only proofs | `PRODUCTION VERIFIED` |

## Where today's operations become ALMA primitives

The aim is to keep the contracts, not to build ALMA now.

| ALMA step | Existing primitive | Contract to keep |
|---|---|---|
| Observe | Posture API (`lib/dashboard/posture.ts`): read-only, permission-scoped, audited | Facts only, no score; a restricted value is never shown as 0 |
| Reason | SoD evaluation, access review items, checklist facts | Deterministic rules with named inputs |
| Recommend | « À traiter » attention rules | A recommendation names its evidence |
| Plan | B4 plan and digest; `RESOURCE.ONBOARDING.PLAN`; operator runner manifests | A plan is data, digested, and expires |
| Approve / policy | B4 typed confirmation; detached human approval of the resource bootstrap; multi-authority restore (`lib/identity/sovereign-recovery.ts`) | Approval binds a digest, never a free action |
| Act | `applyBreakGlass`; the `operation()` writers with a `changeId` | Idempotent, one change per `changeId`, under locks |
| Verify | Committed re-read (Prisma finding P1); digest comparisons | Only the committed state proves an action |
| Audit | Journal (append-only after E2), then Trust Ledger | The record cannot be rewritten by the actor |

**Rule for ALMA later:** it acts as a SERVICE subject with explicit, scoped and time-bound grants, never with ambient or owner authority. This mirrors the B4 operator subject, which holds nothing.
