# Enterprise readiness: what prevents a real company from trusting LUXIA with its identities

Living list, started 2026-10-12 after First Admin / Break-glass v1 (B1 to B5 in Production). It separates **working** from **ready for a company**. Each item cites its evidence:
- **VERIFIED**: observed;
- **ASSUMPTION**: to be confirmed.

Priorities are P0 to P4. Updated at each release.

## Blockers before a paying private beta

| # | Blocker | Evidence | LUXIA fit | Priority |
|---|---|---|---|---|
| E1 | **The platform cannot prove it comes back after losing its database.** No backup outside the Neon project, 6 hours of point-in-time history, no restore ever tested | `docs/operations/BACKUP-RESTORE-PLAN.md` (VERIFIED) | Runtime / operations | **P1** |
| E2 | **The audit trail can be rewritten.** The journal is append-only only for resource-onboarding events; the application role can update or delete the rest, and the sign-in evidence | `docs/architecture/LUXIA-OPERATOR-TRANSPARENCY.md` section 3 (VERIFIED in Production) | Identity → Trust Ledger | **P1** |
| E3 | **Hosting plans and regions are not commercial-grade.** Neon Free, Vercel Hobby, both in the US East region; no service commitment | Inventory (VERIFIED). Hobby for non-commercial use only: ASSUMPTION, check the terms | Runtime / business | **P1** (operator decision) |
| E4 | **No observability.** No error tracking, alerting, uptime check or status page; no logging library. LUXIA would learn about an outage from a customer | `package.json` (VERIFIED); no health route | Runtime / observability | **P1** |
| E5 | **No privacy or legal basis.** No privacy policy, data processing agreement, retention rules or list of subprocessors (Neon, Vercel, Microsoft) | `docs/` (VERIFIED) | Business / legal | **P1** (operator) |
| E6 | **No notification channel.** No e-mail. Invitations are links copied by hand; administrators are not told about sensitive events (operator intervention, new administrator, recovery code used) | `package.json` (VERIFIED) | Platform component | P2 |
| E7 | **Single operator, single workstation.** Every Production operation runs from one Windows machine (runner tied to `%APPDATA%`, local Neon and Vercel sessions) | `docs/handoff/CURRENT-STATE.md` section 10 (VERIFIED) | Operations | P2 |
| E8 | **No incident response.** No runbook beyond B4, no on-call, no way to inform customers during an incident | `docs/` (VERIFIED) | Operations | P2 |
| E9 | **No export.** No export of identities, accesses or journal for the customer's own audits or portability | `app/api` (VERIFIED) | Identity / Trust Ledger | P2 |
| E10 | **Never tested from outside.** No external penetration test | ASSUMPTION (none on record) | Security | P2 before GA, P3 before beta |
| E11 | Administrators cannot revoke a person's passkey from the product (known limit S2); offboarding relies on disabling the account | `docs/handoff/CURRENT-STATE.md` (VERIFIED) | Identity | P2 |
| E12 | Microsoft sign-ins are recorded as provider-attested: no proof of MFA, and the provider's own authentication time is not kept | `docs/architecture/LUXIA-TIME-CONVENTION.md` (VERIFIED) | Identity / Adapters | P3 |
| E13 | Only Microsoft Entra and LUXIA passkeys: no Google, generic OIDC, SAML or SCIM | PR #12 (stale) | Adapters | P3 (expansion) |
| E14 | Security decisions live in code, with no explicit policy | Architecture | Policy | P3 |

## Already strong (keep it that way)

- Forced row-level security per tenant; `app_user` is NOSUPERUSER and NOBYPASSRLS; certified across organizations.
- Phishing-resistant sign-in (passkeys) with recovery codes and a recovery-only session (B2).
- No organization can lose its last administrator (B1); organization status is enforced at sign-in and session level (B3).
- Operator actions only through a closed, planned, digested, journaled procedure (B4), visible to the customer (B5).
- Every release is certified in Production with read-only proofs.

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
