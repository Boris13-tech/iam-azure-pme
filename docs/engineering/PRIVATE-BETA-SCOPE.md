# Private Beta scope

| Item | State |
|---|---|
| Rule | Standard, section 17b: the Beta scope is written and approved by the operator before the gate. It names the pilots' profile, the capabilities and sign-in flows they use, and the legal, retention and hosting requirements that apply to them |
| Approved | By the operator on 2026-10-18. Amended on 2026-10-23 by a decision the operator delegated: the first pilots use passkeys only; Microsoft Entra for a pilot's tenant moves after the Beta. Amended on 2026-11-12 by the operator: retention deadlines per mechanism (section 4; amendment record in section 4.6) |
| Related | [Gate register](PRIVATE-BETA-GATE-REGISTER.md), [pilot agreement draft](../legal/PILOT-AGREEMENT-DRAFT.md) |

## 1. Pilots' profile

| Item | Scope |
|---|---|
| Organizations | 1 to 3, invited by the operator. No public self-service sign-up, no broad deployment |
| People | At most 50 users in total, across all pilots |
| Sign-in | Passkeys and recovery codes |
| Microsoft Entra for a pilot's own tenant | **After the Beta.** A new Entra connection starts DRAFT and no path activates it on `main` or in F4 (finding, 2026-10-23). It needs an Entra activation path (class A), then one real sign-in verified read-only per pilot tenant, and a refused sign-in from a tenant that is not connected |
| Out of scope | Microsoft Entra for a pilot's tenant (above), generic OpenID Connect providers (F4), Google, SAML, SCIM, e-mail notifications (E6), access requests |

## 2. Beta-critical capabilities

| Capability | State |
|---|---|
| Organization sign-up, with the founder on a passkey | PRODUCTION VERIFIED |
| Tenant isolation (forced row-level security; the runtime role cannot bypass it) | PRODUCTION VERIFIED |
| Passkey sign-in, sessions, sign-out; self-service passkey enrolment with the ceremony verified | PRODUCTION VERIFIED |
| Recovery codes and the recovery-only session | PRODUCTION VERIFIED |
| Invitations (a link handed over by the administrator) | PRODUCTION VERIFIED |
| Last-administrator guard; organization status enforced at sign-in | PRODUCTION VERIFIED |
| Leaver: disabling a person ends their sessions and accesses | Proven on PostgreSQL in CI (`tests/resources/leaver-postgres.test.ts`), on mechanisms already PRODUCTION VERIFIED |
| Resources, entitlements, separation of duties, access reviews | PRODUCTION VERIFIED |
| Security journal (append-only) and dashboard | PRODUCTION VERIFIED |
| Microsoft Entra sign-in | Not in the first pilots' scope. PRODUCTION VERIFIED for the operator's tenant only (section 1) |
| Encrypted independent backups and a verified restore | PRODUCTION VERIFIED on the current platform; rehearsed on the target platform (EU-2, G4) |

## 3. Requirements that apply to the pilots

| Area | Requirement before the first pilot |
|---|---|
| Legal | The pilot agreement, its data processing agreement and the privacy notice, reviewed by counsel. The entity that signs them exists |
| Retention | The periods agreed with counsel are **enforced** for the data the pilot creates: purge, pseudonymization and deletion mechanisms built, reviewed and running (standard, section 17b, G8). Disclosing that they are not enforced does not meet this requirement. Deadlines, owners, acceptance criteria, early deletion and legal exceptions: section 4 |
| Hosting | Hosting terms that allow commercial use. Production in the EU |
| Operability | Every promise listed in section 14 of the pilot agreement is operable |

## 4. Retention deadlines (operator amendment of 2026-11-12)

### 4.1 Rule

- Retention is **enforced**, never only disclosed. Mechanisms R1 to R8 are those of [the retention design](../architecture/RETENTION-AND-MINIMIZATION-DESIGN.md).
- **Day 0** is the day the first pilot organization is created in Production: the first pilot data.
- Each mechanism has two dates:
  - **Ready:** implemented, tested on PostgreSQL, reviewed (class A: section 8 of the standard, or EX-004 while it applies), rehearsed on a disposable copy, its Production change written with its rollback, and the operator's GO requested.
  - **Running:** applied in Production through its own release and gate, and verified there with evidence.
- **The deadlines are not development targets.** Every mechanism needed by day 30 is Ready before day 0, so only the Production step can come after the pilot starts. A mechanism that is not Ready by its date blocks the pilot from starting (or from continuing, section 4.5).
- **Safety margin:** a scheduled mechanism runs in Production at least 14 days before the first data reaches its period. 14 days cover the 7-day dry run of the design (section 3), the 3-day heartbeat alert, and 4 days to repair. An on-demand path (erasure of a person or an organization) runs from day 0, because a request can arrive on day 0.
- **Periods are not exemptions.** The periods below are the PROPOSED ones of [the retention policy](../legal/DATA-RETENTION-AND-DELETION.md), not legal advice. They hold only once counsel validates them (G8). No period of 30 days, 90 days or one year allows keeping data that the law, the customer (the controller) or a person's valid request requires to delete earlier. If counsel sets a shorter period, every date below moves earlier by the same amount; if a date can then no longer be met, the pilot does not start.

### 4.2 Deadlines, owners and acceptance criteria

Owner of every line: the **operator** (accountable, Production GO, sole approver). The builder implements; the reviewers review; neither owns a deadline.

| Mechanism | Data and proposed period | Ready | Running in Production | Acceptance criteria (evidence kept in the gate record) |
|---|---|---|---|---|
| R1 | Session network hashes, new sessions: not stored | Before day 0 | Day 0 | Design tests R1; a Production sign-in stores no hash (read-only check) |
| R2 | Session network hashes, existing rows: removed | Before day 0 | Day 0 | Design tests R2; the Production count of non-null hashes is 0 after the run |
| R3 | Expired challenges and Microsoft transactions: purged daily | Before day 0 | Day 0, enforcing (dry run started by day -7) | Design tests R3; one journal event per daily run with counts; 7 dry-run days, then enforcement; a failed run and a 3-day silence each raise an alert, tested once (G7) |
| R4 | Invitations: 30 days after expiry or use | Before day 0 | Day 14 at the latest (dry run from day 7) | Design tests R3, R4; same Production evidence as R3; a held organization is skipped and the skip is journaled (section 4.3) |
| R6, on request | A person, on the customer's erasure request: pseudonymized | Before day 0 | **Day 0** | Design tests R6; executed within 10 working days of the customer's instruction (`DATA-SUBJECT-REQUESTS.md`); rehearsed once in Production on a synthetic person; journal rows byte-identical |
| R6, scheduled | A retired person: pseudonymized 30 days after retirement | Before day 0 | Day 14 at the latest (dry run from day 7) | As R6 on request; one daily run with counts; alerts as R3; a held organization is skipped |
| R7 | A closed organization or a finished pilot: deleted 90 days after closure, or earlier on the customer's request | Before day 0 (in the Release Candidate, #128) | **Day 0** (its migration applied with the operator's GO) | Design tests R7; rehearsed on a disposable copy; operator command with plan, digest and typed identifier |
| R8 | Independent backups: versions older than 30 days removed | Before day 0 (rule written and tested on a test container) | Day 14 at the latest (operator's Azure GO) | A listing shows no version older than 30 days plus the 2-day lifecycle delay; younger versions untouched; the deletion protection of the first 30 days unchanged |
| R5 | Journal, sign-in evidence and ended sessions: one year | Day 240 | Day 300 (first run within 7 days after day 365, then monthly) | Design tests R5; rehearsed on a disposable copy; plan per organization and period with digest; a held organization is skipped |

### 4.3 Early deletion, requests and legal exceptions

| Situation | What applies | From |
|---|---|---|
| A person's erasure, requested through the customer | R6 on request, within 10 working days of the customer's instruction; LUXIA forwards a request it receives directly within 5 working days | Day 0 |
| The customer ends the pilot or asks for its data to be deleted | Export on request (pilot agreement, 9.2), then R7; the 90-day quarantine applies only if the customer does not ask for earlier deletion | Day 0 |
| A legal obligation or a legal claim requires keeping data (GDPR, article 17(3)) | **Hold:** decided by the operator on a written basis (authority request, dispute, counsel's advice), for one organization, recorded in the operator journal with its reason and its review date. R4, R5 and R6 scheduled skip a held organization; for backups, a hold is a separate sealed export, never a suspension of R8. The hold ends at its review date unless renewed with the same record | Written and rehearsed once before day 0 |
| Data already deleted, still in backups | Gone when the backups expire: about 46 days today, at most 32 days once R8 runs. Disclosed in the retention policy; counsel confirms | Day 0 |

Counsel decides before day 0: the periods; the legal basis for keeping security records under a pseudonym; whether pseudonymization meets an erasure request for the journal (retention policy, section 3).

### 4.4 Why no data is kept unlawfully from day 0

- Before a period is reached, the data is kept under the period validated by counsel: the pilot does not start without that validation (G8).
- What can require deletion before the period (a person's request, the end of the pilot, the customer's instruction) is covered on day 0 by R6 on request and R7.
- What requires keeping (a legal obligation or claim) is covered by the hold, written and rehearsed before day 0.
- A scheduled mechanism that would miss its date triggers section 4.5 before any data passes its period.

### 4.5 When G8 is closed, and what happens after

**G8 is declared closed only when all its opening criteria are met, with evidence on the Production state and the release SHA:**
- counsel has reviewed the pilot documents and validated the periods; the signing entity exists;
- hosting terms allowing commercial use, with a DPA; Production in the EU;
- R1, R2, R3, R6 on request and R7 Running; R4, R6 scheduled and R8 Ready; each later date (Running for R4, R6 scheduled and R8; Ready and Running for R5) written as a calendar date in the gate record;
- the hold procedure written and rehearsed once.

Until then G8 stays open, whatever else is done. After day 0, each later Running date is a **condition of G8**, checked with evidence on its date. If the evidence is missing 7 days before a date, the operator suspends the pilot organizations (sign-in refused through the organization status, PRODUCTION VERIFIED), or deletes the data concerned with R7, before any of it passes its period.

### 4.6 Amendment record

| Field | Content |
|---|---|
| Decision | Retention deadlines per mechanism (sections 4.1 to 4.5) in place of "R1 to R8 running before the first pilot" |
| Decided by | The operator, 2026-11-12: option B for the Private Beta Release Candidate, extended to R5 and R8 the same day, completed with guarantees 1 to 7 (owners, margins, Ready before day 0, periods not exemptions, early deletion and exceptions, closure with evidence, traceability) |
| Change from option B as first written | R6 on request and R7 run from day 0, not by day 30: an erasure request can arrive on day 0, and LUXIA commits to act within 10 working days |
| Why | Keep the Release Candidate small (#138 is not complete) without weakening the requirement: retention stays enforced before any data reaches its period |
| Risk accepted | The Production step of R4, R6 scheduled, R8 and R5 happens after the pilot starts and depends on one operator (no on-call); a Running date can slip, mitigated by Ready before day 0, a 14-day margin and the suspension rule |
| Risk not accepted | Data kept beyond its period; an erasure request that cannot be executed; a hold that cannot be applied |
| Review | At the G1 to G8 recompute on the Release Candidate SHA; at day 0; at each Running date; when counsel's periods arrive |
| Reversal | The operator can restore the previous rule by a class C change; it applies from the next pilot |
