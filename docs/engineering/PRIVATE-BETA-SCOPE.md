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
- Each mechanism has two states:
  - **Ready:** implemented, tested on PostgreSQL, reviewed (class A: section 8 of the standard, or EX-004 while it applies), rehearsed on a disposable copy, its Production change written with its rollback, and the operator's GO requested. A scheduled mechanism is not Ready without three alerts, each tested once: a failed run; no run for 3 days; an eligible record older than its period plus 3 days (backlog). None of them exists today for the retention job: the error alert needs monitoring slice M-C activated, and the other two are not written.
  - **Running:** applied in Production through its own release and gate, and verified there with evidence.
- **Every mechanism whose period is shorter than one year enforces in Production at day 0** (R1 to R4, R6, R7, R8). The pilot therefore never depends, for these, on a deadline that falls after it starts, and the deadlines are not development targets. Only R5 (one year) has later dates, with the margins of section 4.5.
- **A period is a window, not an instant.** A record is deleted after its period and within the tolerance of its mechanism (table 4.2), never before a minimum that the policy sets. The tolerance covers how the mechanism runs (daily, monthly, or the storage platform's own processing); it is stated to the customer (pilot agreement, 9).
- **Periods are not exemptions.** They are the PROPOSED ones of [the retention policy](../legal/DATA-RETENTION-AND-DELETION.md), not legal advice, and hold only once counsel validates them (G8). No period allows keeping data that the law, the customer (the controller) or a person's valid request requires to delete earlier. If counsel sets other periods or tolerances, this section changes before day 0; a mechanism that cannot meet them blocks the pilot.

### 4.2 Deadlines, owners and acceptance criteria

Owner of every line: the **operator** (accountable, Production GO, sole approver). The builder implements and produces the evidence; the independent reviewers check that evidence before the operator accepts it; the builder never accepts its own evidence. Neither the builder nor a reviewer owns a deadline.

| Mechanism | Data, period and tolerance | Ready | Running in Production | Acceptance criteria (evidence kept in the gate record) |
|---|---|---|---|---|
| R1 | Session network hashes, new sessions: not stored | Before day 0 | Day 0 | Design tests R1; a Production sign-in stores no hash (read-only check) |
| R2 | Session network hashes, existing rows: removed | Before day 0 | Day 0 | Design tests R2; the Production count of non-null hashes is 0 after the run |
| R3 | Expired challenges and Microsoft transactions; tolerance 7 days | Before day 0 | Enforcing at day 0 (dry run from day -7) | Design tests R3. Each daily run journals its counts, **the eligible records left and the age of the oldest one**. The three alerts of 4.1, each tested once (G7). After the 7 dry-run days, no eligible record older than its period plus 7 days |
| R4 | Invitations: 30 days after expiry or use; tolerance 7 days | Before day 0 | Enforcing at day 0 (dry run from day -7) | As R3; design tests R4; a held organization is skipped and the skip is journaled (4.3) |
| R6, on request | A person, on the customer's erasure request: pseudonymized within 10 working days of the instruction | Before day 0 | Day 0 | Design tests R6; rehearsed once in Production on a synthetic person (a Production change with the operator's GO; its journal events stay, by design); journal rows byte-identical; the hold check of 4.3 recorded in the run's plan |
| R6, scheduled | A retired person: pseudonymized 30 days after retirement; tolerance 7 days | Before day 0 | Enforcing at day 0 (dry run from day -7) | As R4 |
| R7 | A closed organization or a finished pilot: deleted 90 days after closure, or earlier on the customer's request | Before day 0 (in the Release Candidate, #128) | Day 0 (its migration applied with the operator's GO) | Design tests R7; rehearsed on a disposable copy; operator command with plan, digest and typed identifier; the hold check of 4.3 recorded in the plan |
| R8 | Independent backups: immutable 30 days, then removed by the lifecycle rule after day 31, then purged from the storage's recycle bin. **Not a guaranteed maximum:** about 33 days with a 1-day recycle bin, 46 days with 14 days; the storage platform gives no deadline for its processing (`BACKUP-RUNBOOK.md`, 8.1) | Before day 0 (rule and recycle-bin period chosen by the operator, tested on a test container) | Day 0 (operator's Azure GO) | The policy and the recycle-bin period read back equal to what was decided (runbook 8.3). **Every week**, the count of versions older than 31 days plus the recycle-bin period plus 3 days, **deleted versions included**, is 0, kept in the gate record; a non-zero count is an incident (4.5) |
| R5 | Journal, sign-in evidence and ended sessions: kept **at least** one year (policy minimum), deleted within the following month | Day 180 | Day 240; first run between day 365 and day 395, then every month | Design tests R5 (no cutoff more recent than one year is accepted); rehearsed on a disposable copy; plan per organization and period with digest; a held organization is skipped; after each run, no record older than one year plus one month remains and none younger than one year was deleted |

### 4.3 Early deletion, requests and legal exceptions

| Situation | What applies | From |
|---|---|---|
| A person's erasure, requested through the customer | R6 on request, within 10 working days of the customer's instruction; LUXIA forwards a request it receives directly within 5 working days | Day 0 |
| The customer ends the pilot or asks for its data to be deleted | Export on request (pilot agreement, 9.2), then R7; the 90-day quarantine applies only if the customer does not ask for earlier deletion | Day 0 |
| A legal obligation or a legal claim requires keeping data (GDPR, article 17(3)) | **Hold.** LUXIA is the processor, so it holds data only on the customer's documented instruction, or when EU or member-state law that binds LUXIA requires it (GDPR, article 28(3)(a)); counsel confirms each case. The operator records it for one organization, with its basis, its scope and its review date, in the **hold register**: a table in the database, written only by an owner-only operator function that also writes an operator journal event, and read by the scheduled deletion functions (built and reviewed with #138, class A); the basis documents stay in the private record. **A hold ends only by a documented release** (the basis has ended, recorded the same way). A review date that passes never releases it: the hold stays in effect, an overdue-review alert is raised, and the weekly status report lists it until it is renewed or released. Tested: a hold past its review date is still skipped by every scheduled deletion | Register built, written and rehearsed once before day 0 |
| A hold and a deletion meet | **The hold takes precedence over every deletion path.** R4, R5 and R6 scheduled read the hold register and skip a held organization, and their run journals the skip. R6 on request, R7 and the end-of-pilot path are not run on held data: a person's erasure request on held data becomes a restriction of processing (GDPR, article 18) as counsel advises, and the customer is told. Before every run of R6 on request or R7, the operator checks the hold register and records the check in the run's plan. Until these commands read the hold register and refuse a held organization themselves (follow-up before general availability; R7 is already in the Release Candidate), this check is procedural (4.6) | Day 0 |
| Data already deleted, still in backups | No deletion path removes an immutable backup. Deleted data stays in the backups until they end under R8 (window above). Stated in the pilot agreement (9.2); counsel confirms | Day 0 |

Counsel decides before day 0: the periods and tolerances; the legal basis for keeping security records under a pseudonym; whether pseudonymization meets an erasure request for the journal (retention policy, section 3); the backup window.

### 4.4 Why no data is kept unlawfully from day 0

- Every mechanism whose period is shorter than one year enforces at day 0. R5's first deletion is due on day 365 (its policy minimum), and R5 is Running from day 240.
- What can require deletion before a period ends (a person's request, the end of the pilot, the customer's instruction) is covered at day 0 by R6 on request and R7.
- What requires keeping (a legal obligation or claim) is covered by the hold, which takes precedence over every deletion path.
- A running mechanism can still fail. The alerts of a daily mechanism detect it within 3 days, and the same function can be run by hand (rehearsed), so a record outlives its window by days, not weeks. R8 is checked every week, so a backup can outlive its estimate by up to 7 days before the check sees it. Beyond that, section 4.5 applies.

### 4.5 When G8 is closed, and what happens after

**G8 is declared closed only when all its opening criteria are met, with evidence on the Production state and the release SHA:**
- counsel has reviewed the pilot documents and validated the periods and tolerances; the signing entity exists;
- hosting terms allowing commercial use, with a DPA; Production in the EU;
- R1, R2, R3, R4, R6 (on request and scheduled), R7 and R8 Running, with their alerts tested;
- R5 Ready and Running dates written as calendar dates in the gate record, and as GitHub milestones;
- the hold register built (R4, R5 and R6 scheduled skip a held organization, tested), the hold procedure written and rehearsed once;
- the pilot agreement's retention terms (9) and its operability table (14) consistent with this section.

Until then G8 stays open, whatever else is done. After day 0:
- **A running mechanism outside its window** (backlog alert, or a non-zero weekly R8 count) is an incident: within 2 working days the operator runs the same function by hand, or the fix follows the class A path; the customer is told under the agreement (8.4) when its data has outlived its window; the weekly status report tracks it until the window holds again. Ending the pilot does not shorten such an overrun, because the export takes up to 30 days.
- **R5:** its dates are milestones and the weekly status report names the next one. If R5 is not Ready by day 180, the operator tells the customer and prepares the end of the pilot. If R5 is not Running by day 240, the pilot ends that day: the organization is closed, the export follows the agreement during the 90-day quarantine (request within 15 days, delivery within 15 days), and R7 erases the organization on day 330, held data excepted: 35 days before the first journal record reaches one year. The quarantine is kept, no record passes its period, and the closed-organization rule of the retention policy (deletion 90 days after closure) is the one that applies to the journal of a closed organization.

### 4.6 Amendment record

| Field | Content |
|---|---|
| Decision | Retention deadlines per mechanism (sections 4.1 to 4.5) in place of "R1 to R8 running before the first pilot" |
| Decided by | The operator, 2026-11-12: option B for the Private Beta Release Candidate (the Release Candidate without #138), extended to R5 and R8 the same day, completed with guarantees 1 to 7 (owners, margins, Ready before use, periods not exemptions, early deletion and exceptions, closure with evidence, traceability) |
| Changes from option B as first written | Every mechanism with a period under one year enforces at day 0, not by day 30: an erasure request can arrive on day 0, a 30-day period leaves no room for a failed launch, and the end-of-pilot export takes up to 30 days. #138 still stays out of the Release Candidate and reaches Production in its own release before the pilot. Only R5 keeps later dates |
| Why | Keep the Release Candidate small (#138 is not complete) without weakening the requirement: retention stays enforced from the first day for every period under one year |
| Risk accepted | The hold check before R6 on request and R7 is procedural until the commands refuse a held organization (before general availability). R8's window is an estimate: the storage platform gives no deadline, so it is verified weekly rather than guaranteed. A running mechanism can fail after day 0 and a record can outlive its window until the fix. One operator, no on-call |
| Risk not accepted | A period under one year without a running mechanism at day 0; an erasure request that cannot be executed; a deletion that overrides a hold; a deletion before a policy minimum |
| Review | At the G1 to G8 recompute on the Release Candidate SHA; at day 0; at each R5 date; when counsel's periods arrive; after any incident of 4.5 |
| Reversal | The operator can restore the previous rule by a class C change; it applies from the next pilot |
| Evidence of the decision | The operator merges this change by hand. Until GOV-002 closes, agents act through the operator's GitHub identity, so GitHub alone cannot prove who approved; the decision is also kept in the operator's private gate record, with its date and wording |
