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
| E1 | **Prove that LUXIA comes back after losing its database** | `docs/certification/E1-BACKUP-RESTORE-DRILL-B-2026-10-13.md` (VERIFIED) | Runtime / operations | **P1** | `PRODUCTION VERIFIED` for the database (2026-10-13):<br>• encrypted backup every 6 hours, outside Neon, in the EU, protected against deletion;<br>• Drill B rebuilt Production from it into an empty environment, identical, with RPO 2 min 7 s and 81 s to a verified database.<br>Still open:<br>• rehearsing the switch of the application;<br>• the operator's key custody (P1);<br>• the immutability lock (operator decision);<br>• a backup freshness alert (E4) |
| E2 | **The audit trail is append-only for application and ordinary operator roles.** Until 2026-10-13 the application role could update or delete journal rows (except resource onboarding) and every sign-in evidence row. Not cryptographic immutability (Trust Ledger) | `docs/certification/T0-AUDIT-APPEND-ONLY-RELEASE-2026-10-13.md` | Identity, then Trust Ledger | **P1** | `PRODUCTION VERIFIED` (T0, 2026-10-13: real UPDATE and DELETE refused for `app_user` and the owner) |
| E3 | **Commercial-grade hosting in the EU.** Today: Neon Free and Vercel Hobby, both in US East, no service commitment. Vercel: « Our Hobby plan is for personal, non-commercial use » (VERIFIED, pricing page) | Inventory (VERIFIED) | Runtime / business | **P1** | `DESIGNED` (`docs/operations/HOSTING-EU-AND-COSTS.md`, `EU-MIGRATION-RUNBOOK.md`). **Zero-euro mode (operator, 2026-10-18):** the move to the EU runs at €0 (Neon Free in Frankfurt, Vercel Hobby with functions in `fra1`) and is **rehearsed** (EU-2 and G4, 2026-10-18). Commercial hosting terms (Vercel Pro) are `BLOCKED_BY_BUDGET` until the operator decides |
| E4 | **Observability.** **Backup freshness: done** (2026-10-13).<br>• hourly trigger from Azure: the GitHub scheduler had never run at diagnosis time. On 2026-10-14 it ran 4 times in 18 slots, irregularly, and each run was an extra backup. So it is kept only as a fallback, gated so that it never doubles the backups (E4 certification, section 7: the gate is implemented, and becomes `PRODUCTION VERIFIED` once a scheduled run is observed applying it);<br>• an alert outside GitHub after 3 hours without a backup;<br>• Fired and Resolved received on both of the operator's addresses, and automatic resolution observed (`docs/certification/E4-BACKUP-FRESHNESS-ALERT-2026-10-13.md`).<br>**Still missing:** error tracking, uptime check, alerts on server errors, latency and database availability, a status page, a logging library, and a second watcher outside Azure for the backup chain. LUXIA would still learn about an application outage from a customer | Azure alerts `luxia-backup-freshness` and `-drill`, Logic App `luxia-backup-dispatcher` (VERIFIED) | Runtime / observability | **P1** | Backup freshness: `PRODUCTION VERIFIED`. Application monitoring: `DESIGNED` at zero cost (#92); liveness and readiness (#102) and scrubbed error events with SLI-03 (#108) written and in review, **not merged** |
| E5 | **Privacy and legal basis:** privacy policy, data processing agreement, subprocessors (Neon, Vercel, Microsoft), retention and deletion, data subject requests, breach notification, data residency | `docs/legal/` (drafts, 2026-10-13) | Business / legal | **P1** | `DESIGNED`: 8 technical drafts, all marked `DRAFT — LEGAL REVIEW REQUIRED`; counsel, the legal entity and the decisions marked `[TO BE DECIDED]` are missing |
| E6 | **Notification channel**, provider-neutral (`Notification → Channel Adapter`). Today there is no e-mail; invitations are links copied by hand; administrators are not told about sensitive events | `package.json` (VERIFIED) | Platform component | P2 | `DESIGNED` (contract only: `docs/architecture/NOTIFICATION-CONTRACT.md`) |
| E7 | **More than one operator and one workstation.** Today every Production operation runs from one Windows machine | `docs/handoff/CURRENT-STATE.md` section 10 (VERIFIED) | Operations | P2 | `UNKNOWN` |
| E8 | **Incident response:** runbook, on-call, customer communication | `docs/legal/INCIDENT-RESPONSE-AND-BREACH-NOTIFICATION.md` (draft) | Operations | P2 | `DESIGNED` (draft procedure; no on-call, no practice run) |
| E9 | **Export** of identities, accesses and journal, for the customer's audits and portability | `app/api` (VERIFIED, none) | Identity / Trust Ledger | P2 | `UNKNOWN` |
| E10 | **External penetration test** | ASSUMPTION (none on record) | Security | P2 before GA, P3 before beta | `UNKNOWN` |
| E11 | **Administrators can revoke a person's passkey** (known limit S2) | `docs/handoff/CURRENT-STATE.md` (VERIFIED) | Identity | P2 | `UNKNOWN` |
| E12 | **Microsoft sign-ins:** proof of MFA and the provider's own authentication time | `docs/architecture/LUXIA-TIME-CONVENTION.md` (VERIFIED, both missing) | Identity / Adapters | P3 | `UNKNOWN` |
| E13 | **Sovereign Provider & Federation Layer.** Providers plug into LUXIA, never the reverse. A generic OIDC core with Microsoft as one profile, a per-connection kill switch, secrets in a vault, then Google and a private IdP through the same engine (R10: replaceable with the authority unchanged). SAML and SCIM come later | `docs/architecture/SOVEREIGN-PROVIDER-FEDERATION-LAYER-DESIGN.md` (approved 2026-10-13, #62). F1: #63. F2: #66 and `docs/architecture/F2-PROVIDER-CONNECTION-LIFECYCLE.md` | Adapters / Identity | **P1** before widening the beta | **F1** generic OIDC core: **`PRODUCTION VERIFIED`** on 2026-10-14. `41d58d2` was deployed, then the operator's real Microsoft sign-in passed 11/11 read-only checks (evidence at 18:58:24Z).<br>**F2** lifecycle, kill switch and connection isolation: **COMPLETE, `PRODUCTION VERIFIED`** on 2026-10-15 (#66, #67; `docs/architecture/F2-PROVIDER-CONNECTION-LIFECYCLE.md`). M1 (status, guards, kill switch) applied at 16:17Z, the F2 code `d631edb` deployed at 17:02Z, M2 (forced row-level security on ProviderConnection) applied at 22:05Z. Each step was rehearsed first on a fresh clone of Production with a lossless rollback. Each was then verified in Production: Microsoft 11/11 and existing-passkey 6/6 sign-ins, every organization unchanged, and the next backup verified. `main` now matches Production for F2 (`84c4e45`). Left for F4: the Production proof of DISABLE, QUARANTINE, RELEASE and ACTIVATE on a test connection (`VERIFIED` by CI and rehearsals).<br>**F3** secret store (per-connection references, Key Vault, secretless federation): `IMPLEMENTED` in #69 (not merged). **Its references migration is `PRODUCTION VERIFIED`** on 2026-10-16: applied, rolled back and re-applied in Production, the table empty, business data unchanged, Microsoft and passkey sign-ins pass, backups 52 tables and 28 migrations. The vault, the wiring and the guard wait for the Key Vault decision (`F3-KEY-VAULT-DECISION.md`).<br>**F4 to F6:** `DESIGNED` |
| E18 | **Self-service passkey enrollment verifies the WebAuthn ceremony.** Until #64, the dashboard route stored the public key sent by the browser with no ceremony check, and labelled it hardware-bound. An attacker with a stolen FULL administrator session could add a key they control (found by the LUXIA Key audit, 2026-10-14) | `app/api/auth/local/enrollment/complete/route.ts` on `main` (VERIFIED). Fix: #64 | Identity | **P1** | **`PRODUCTION VERIFIED`** on 2026-10-14. #64 was deployed alone at `368503e`. A real passkey enrollment and a real passkey sign-in passed 9/9 read-only checks: the new key is `hardwareBound = false` and requires user verification. #64 is merged. **G1 applied** (19:21Z, operator gate): the 7 earlier passkeys no longer claim hardware binding; 6/6 checks passed; one operator journal event. The 25 sign-in records that carried the claim stay as recorded (append-only) |
| E14 | **Explicit security policies** instead of rules in code | Architecture | Policy | P3 | `UNKNOWN` |
| E15 | **Network identifiers are minimized.** Today every session keeps an **unsalted** SHA-256 of the IP address and of the user agent, with no limit. An IPv4 address can be recovered from such a hash by trial, so these are personal data. The abuse counters keep the same kind of hash for 2 days | `lib/auth/session-store.ts`, `lib/security/rate-limit.ts` (VERIFIED) | Identity / privacy | P2 | **R1 written and in review (#107), not merged:** until it is merged and deployed, sessions still store the hashes. Once merged, sessions no longer store network identifiers (nothing reads them, so no keyed hash is needed). Existing rows: R2, a one-way redaction in the session guard, `DESIGNED` (`docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md`) |
| E16 | **Retention and deletion are enforced.** Today sessions, challenges, Microsoft sign-in transactions, the journal and the sign-in records are kept with no limit, and a closed organization is never deleted | `docs/legal/DATA-RETENTION-AND-DELETION.md` section 1 (VERIFIED) | Identity / privacy | P1 before a commercial beta | `DESIGNED`: mechanisms R1 to R8 (`docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md`); periods to decide with counsel |
| E17 | **CI/CD environments protect Production secrets.** The GitHub environment `Production` holds the Production owner and runtime credentials. It had no protection rule: anyone with write access, or a leaked token with that access, could run the two Production workflows by hand, or reach those secrets from any branch | `gh api …/environments` (VERIFIED 2026-10-13, before and after) | Security / operations | **P1** | `VERIFIED` (2026-10-13, operator decision): `main` only, the operator as required reviewer, `can_admins_bypass=false`. Unchanged: `Preview` (no secret) and `staging` (its own database credentials, presumably those of the `luxia-staging` project; ASSUMPTION, since secret values cannot be read). Proposal: the same protection on `staging` |

## Already in place

| Capability | Status |
|---|---|
| Forced row-level security per tenant; `app_user` NOSUPERUSER and NOBYPASSRLS; certified across organizations | `PRODUCTION VERIFIED`. **Except `ProviderConnection`**, which has none (finding M3, VERIFIED 2026-10-14). It is closed by F2 M2, after the F2 code is in Production |
| Phishing-resistant sign-in (passkeys), recovery codes and a recovery-only session (B2) | `PRODUCTION VERIFIED`. Self-service enrollment from the dashboard now verifies the ceremony (E18, PRODUCTION VERIFIED on 2026-10-14) |
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
