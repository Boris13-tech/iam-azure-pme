# LUXIA Mission-Critical Engineering Standard v1

| Item | State |
|---|---|
| Status | **In force** since its merge on 2026-10-17 (#81, approved by the operator with the modifications recorded in sections 1, 1b, 16 and 17). Amendments are listed in section 19 |
| Scope | LUXIA Identity: this repository, its CI, its Production and every change to them |
| Effect | Governance only. **No runtime, migration, secret, environment or Production change** comes with this standard |
| Companion documents | [Gap analysis](GAP-ANALYSIS-2026-10-17.md), [trust-boundary registry](TRUST-BOUNDARY-REGISTRY.md), [service-level register](SERVICE-LEVEL-REGISTER.md), [templates](templates/) |

LUXIA Identity decides who may act in an organization. A defect in it is not a degraded feature. It can mean another organization's data exposed, an unauthorized administrator, or an organization locked out of its own systems. This standard states what must be true, and proven, before a change can be called done.

Evidence labels used throughout:
- **VERIFIED:** read in the repository or observed;
- **ASSUMPTION:** to confirm;
- **UNKNOWN:** not established.

## 1. The seven superior invariants

These invariants rank above every feature, deadline and convenience.
- A change may never weaken one silently.
- Weakening one requires an ADR approved by the operator, a threat model, and a PRODUCTION GATED change of its own.

> **Origin.** The seven are derived from rules already decided and enforced: the sovereign design rules R1 to R10, T0, the F2 and M2 phases, F3, the B-series and E1. They were approved in principle by the operator on 2026-10-17, who reworded I4 and I7. The former I7, "every change is gated and reversible", is no longer an invariant; it stays a **mandatory engineering rule** (section 1b).

| # | Invariant | Derived from | Enforced today (VERIFIED) |
|---|---|---|---|
| **I1** | **Authority is LUXIA's alone.** Only an explicit, scoped, journaled and revocable LUXIA decision grants access. No provider claim, group, synchronization or automation creates or extends authority | R1, R6 | Architecture tests: no adapter writes authority tables. Route tests: claims change nothing (F4 S4) |
| **I2** | **Isolation is enforced by the database.** No organization reads or writes another's data. The application's scope is never trusted alone | R7, M2 | FORCE row-level security on tenant tables; app_user has NOBYPASSRLS; RLS suites across organizations in CI |
| **I3** | **Fail closed, answer generically.** Unknown, invalid, ambiguous or failing input refuses. An infrastructure failure denies, it never allows. Refusals reveal nothing to the browser | R8, B3 | Negative test tables (R8). The authorization gateway denies on error. Login answers are identical for unknown and refused cases |
| **I4** | **Every security-sensitive action or state transition is attributable and produces append-only evidence atomically with its effect.** *(Operator wording, 2026-10-17)* | T0, W1/W2, R9 | Append-only triggers on the journal, sign-in evidence and test runs. A session and its sign-in evidence are written in one transaction. Every administrator operation and its journal event commit together, with the actor recorded |
| **I5** | **Secrets are referenced, never exposed.** No secret in code, logs, payloads, responses or shared global configuration. Production reads provider secrets by reference from a vault | F3, operator rules | Secret references only (database CHECKs); secret leases redact themselves; tests assert that errors carry no secret. *Vault not wired yet (F3 steps 1–7, gated)* |
| **I6** | **Continuity: no lock-out, no silent data loss.** Local sign-in and recovery never depend on an external provider. A provider outage never revokes a session. Backups are independent, verified and restorable | R3, R5, B2/B4, E1 | LUXIA_LOCAL always ACTIVE (database guard); break-glass procedure; hourly independent backup with CI round-trip restore. *A 4-hour RPO is not guaranteed until external alerting and catch-up are operational* |
| **I7** | **A provider is replaceable without loss or modification of LUXIA authority, history or Subjects.** *(Operator wording, 2026-10-17)* | R10, R1, R4 | Authority (assignments, entitlements) attaches to Subjects, never to provider accounts; a provider link is an `IdentityAccount` that can be replaced; the journal and evidence are append-only. *The R10 replacement rehearsal (F4 S8) has not run yet* |

**Every PR that touches an invariant names it**, in its description and its threat model, with the evidence that it still holds.

## 1b. Mandatory engineering rules

These rules are obligatory for every change. They are not among the seven invariants (operator decision, 2026-10-17).

| # | Rule | Where it is detailed | Enforced today (VERIFIED) |
|---|---|---|---|
| **ER1** | **Every change is gated and reversible.** Changes reach Production only through gates, with a rehearsed rollback or an approved forward-only plan, and an exact record of what was deployed | Sections 10, 11 and 13 | Expand-only migrations with rollback scripts and CI drills; gate tools with sealed evidence; exact-commit deployments |

## 2. Assurance lifecycle

A change moves through these states in order. Each state needs the evidence listed before it can be claimed. **A status is never claimed without its evidence.**
- CI green is not PRODUCTION VERIFIED.
- One provider certified is not "multi-provider".
- A merge is not a deployment.

| State | Meaning | Entry criteria and required evidence | Decided by |
|---|---|---|---|
| **DESIGNED** | The problem, the scope and the decision are written | ADR or RFC (section 4): invariants touched, alternatives, decisions, risks, rollback strategy | Author; operator for decisions |
| **THREAT-MODELED** | The ways it can be abused are known and each has an answer | Threat model (section 5, [template](templates/THREAT-MODEL-TEMPLATE.md)): boundaries crossed, threats per boundary, mitigation, test ID, residual risk. Registry updated (section 6) | Author; reviewed at INDEPENDENTLY REVIEWED |
| **IMPLEMENTED** | Code, migration, rollback and tests exist off Production | CI green (unit, architecture, PostgreSQL suites, backup round trip). Migration expand-only with rollback (section 13). No Production effect | CI |
| **ADVERSARIALLY TESTED** | Every threat has a test that fails when its control is removed | Section 7: one test per refusal; replay, race, outage, cross-tenant and mix-up cases; traceability from threat rows to test IDs | CI plus traceability table |
| **INDEPENDENTLY REVIEWED** | Someone other than the author has reviewed it and every finding is closed or accepted | Section 8, [record](templates/INDEPENDENT-REVIEW-TEMPLATE.md) | Reviewer; operator accepts residual findings |
| **STAGING VERIFIED** | It behaved correctly in a Production-like place before Production | Section 9: staging run with Production-equivalent configuration, or a fresh-clone rehearsal for data changes, with sealed evidence | Author; evidence |
| **PRODUCTION GATED** | A written gate is ready and approved | Section 10, [template](templates/PRODUCTION-GATE-TEMPLATE.md): tool tested on a disposable clone, backup, rollback rehearsed, the operator's explicit "go" | **Operator** |
| **PRODUCTION VERIFIED** | The gate ran, every after-check passed, real-scenario proofs passed | Sealed gate evidence, closure note, the exact deployment and commit recorded | Author; operator reads the closure |
| **OPERATIONALLY PROVEN** | It has run in Production long enough, under measurement, to be trusted | Section 17 | **Operator** |

**Rules:**
- **No skipping** for class A changes (section 3). Class B and C follow section 3.
- **Demotion.** A state is lost when its evidence stops being true, for example a regression, a failed after-check, an incident attributable to the change, or a dependency changed underneath. The item then returns to the highest state whose evidence still holds.
- **Labels.** PRs, designs and readiness documents show the current state. The previous ladder maps as follows:

| Previous label | Mapping |
|---|---|
| UNKNOWN | Not yet DESIGNED |
| DESIGNED | DESIGNED |
| IMPLEMENTED | IMPLEMENTED |
| VERIFIED (CI) | IMPLEMENTED, plus ADVERSARIALLY TESTED only where a traceability table exists |
| PRODUCTION VERIFIED | PRODUCTION VERIFIED; the missing intermediate states are recorded as debts (section 18) |

## 3. Change classes

| Class | What | Required states |
|---|---|---|
| **A: critical** | Touches an invariant or a trust boundary: authentication, authorization, sessions, tenancy and RLS, secrets, the journal or evidence, migrations, backup and restore, provider federation, CI/CD and supply chain, Production configuration | **All nine states, in order** |
| **B: standard** | A runtime change outside class A (UI, labels, non-security logic) | DESIGNED (short form), IMPLEMENTED, INDEPENDENTLY REVIEWED, PRODUCTION GATED (light form allowed), PRODUCTION VERIFIED. A threat model only when the author or the reviewer finds a boundary touched; the class is then raised to A |
| **C: non-runtime** | Documentation, tests only, local tooling, governance | DESIGNED (PR description), reviewed before merge |

When in doubt, the class is A. The reviewer may raise a class; only the operator may lower one.

## 4. ADR and RFC requirements

| Document | When | Status lifecycle |
|---|---|---|
| **ADR** (architecture decision record) | A decision with lasting effect: a boundary, a data model, a security mechanism, a dependency, a provider, an invariant | Proposed, Accepted, Superseded by ADR-n, Rejected |
| **RFC** (request for comments) | A change large enough to need options compared before deciding: a phase, a migration programme, a new product capability | Draft, In review, Decided (with ADRs), Withdrawn |

**Required content** (templates: [ADR](templates/ADR-TEMPLATE.md), [RFC](templates/RFC-TEMPLATE.md)):
- context and evidence (VERIFIED, ASSUMPTION or UNKNOWN);
- the invariants touched;
- the options, with the reason for the choice;
- the decision and who took it;
- consequences, risks and residual risk;
- the rollback or exit strategy;
- the tests that will prove it;
- the operator decisions requested.

**Rules:**
- An ADR is never edited after acceptance except to mark it superseded.
- Design documents already in `docs/architecture/` count as RFCs. Their decision tables count as ADRs until they are split out (section 18).
- Operator decisions are recorded with their date and exact wording, including modifications (for example F4-5, "approved as modified").

## 5. Threat modeling

**Required for every class A change, before IMPLEMENTED is claimed.** Use the [template](templates/THREAT-MODEL-TEMPLATE.md).

**Method:**
- List the trust boundaries crossed (section 6).
- For each boundary, apply STRIDE (spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege).
- Add the abuse cases specific to identity: mix-up, replay, confused deputy, account linking, cross-tenant access, downgrade, enumeration.
- Check each of the seven invariants explicitly.

**Every threat row gives:**
- a mitigation;
- **the test ID that proves it** (section 7);
- the residual risk;
- its owner.

**Refresh triggers:**
- a new boundary;
- a new dependency or provider;
- an incident;
- a finding at review.

**Public repository rule:** a threat whose mitigation is not yet in place, and that could help an attacker, is recorded in the private record. The public document gives a reference only, never the detail.

## 6. Trust-boundary registry

[`TRUST-BOUNDARY-REGISTRY.md`](TRUST-BOUNDARY-REGISTRY.md) lists every place where data or control crosses from one trust level to another. For each boundary it gives:
- the two sides;
- what crosses;
- the authentication;
- the authorization;
- the input validation;
- the secrets involved;
- the failure behaviour;
- the evidence written;
- the tests;
- its assurance state.

**Rule:** a PR that creates, removes or changes a boundary updates the registry in the same PR. The reviewer checks it.

## 7. Adversarial testing

ADVERSARIALLY TESTED requires, for class A:
1. **One test per refusal**: every rule that says "refuse" has a test that triggers it, and the test asserts the safe outcome (generic answer, no session, no write, journaled denial).
2. **Abuse cases from the threat model**:
   - replay and reuse;
   - concurrency races (single-use, last-administrator, quarantine);
   - cross-tenant attempts;
   - mix-up between connections;
   - malformed and oversized input;
   - downgrade attempts (algorithms, schemes);
   - time manipulation (expiry, freshness).
3. **Failure injection**: dependency down, slow, or answering errors (identity providers, secret store, database), with the invariant I6 outcome asserted (existing sessions unaffected).
4. **Invariants held on the source**: architecture tests that fail if a control is bypassed. Examples: no unscoped read, no IdP request outside the SSRF guard, no claim to authority.
5. **Database-level enforcement tested directly**: as the owner and as `app_user`, not only through the application.
6. **Control sanity**: for each new control, the author shows once that its test **fails when the control is removed**, and records it in the PR (a mutation check). A test that cannot fail proves nothing.
7. **Traceability**: a table from threat rows to test IDs, in the PR or the threat model.

## 8. Independent review

INDEPENDENTLY REVIEWED requires a review by **someone other than the author**:
- **Class A, author is an AI agent:** at least one **human** reviewer competent in the area. A review by another AI model or session may complement it, never replace it.
- **Class A, author is a human:** a second human, or the operator with a written checklist when no second person exists. This is a recorded exception, not the norm.
- **Production gates:** the gate procedure and tool are reviewed too, not only the code.

The review is recorded with the [template](templates/INDEPENDENT-REVIEW-TEMPLATE.md):
- scope (commit range);
- checklist: invariants, boundaries, threat model, tests, migration, rollback, evidence, supply chain;
- findings with severity;
- resolution of each finding, or the operator's written acceptance.

**A class A change is not merged while a blocking finding is open.**

## 9. Staging verification

STAGING VERIFIED requires one or both of the following, as the change needs:
- **(a) A staging run.** A non-production environment configured like Production:
  - the same authorization mode;
  - row-level security and roles;
  - no Production secret.
  It runs the change and the gate's own checks.
- **(b) A fresh-clone rehearsal** for any change to data or schema:
  - a disposable branch of current Production;
  - BEFORE, APPLY, AFTER, ROLLBACK and REAPPLY;
  - immutable manifests with SHA-256 and an index;
  - Production proven unchanged;
  - the clone deleted only after the evidence is verified.

A change that touches both code and schema needs both forms, or a written reason why one is enough.

## 10. Production gates

PRODUCTION GATED and PRODUCTION VERIFIED follow the [gate template](templates/PRODUCTION-GATE-TEMPLATE.md).

**Preconditions:**
- the exact commit, reviewed;
- full CI green on that commit;
- a fresh backup verified;
- the BEFORE state equal to the rehearsal's;
- the gate tool tested on a disposable clone (dry run);
- a rollback that was rehearsed.

**The gate:**
- **"go" from the operator, in writing;**
- each Production write behind an explicit confirmation token;
- the tool refuses if data, definitions or code differ from what was rehearsed.

**After:**
- every after-check;
- real-scenario proofs (for example a real Microsoft sign-in, a real passkey sign-in), always with the operator's own account and never a test account in Production;
- the next scheduled backup verified;
- sealed evidence (index hash);
- a closure note;
- an observation period.

**Rollback triggers are written in advance.** A single failed check before closure triggers the rollback; nobody improvises.

## 11. Rollback requirements

Every class A change has one of the following before PRODUCTION GATED:
- **A rollback**:
  - written (SQL file or redeploy target);
  - **drilled** (in CI for migrations, on a clone for data);
  - with its **lossless window** stated (until when it restores exactly);
  - with its **refusal when in use** (it refuses rather than destroys data written since);
  - with its expected duration.
- **Or a forward-only declaration**, approved by the operator before the gate, with the forward fix described.

**Code deployments:** the previous Production deployment is recorded as the rollback target before every deploy.

**Expand/contract:** destructive schema steps (DROP, type narrowing) come only in a later, separate change, after the expanding change is OPERATIONALLY PROVEN.

## 12. Evidence requirements

| Requirement | Rule |
|---|---|
| Content | Inputs, commands, outputs and digests that allow someone else to check the claim. Labelled VERIFIED, ASSUMPTION or UNKNOWN |
| Immutability | Manifests written once (noclobber, read-only) with SHA-256 and an index. Any change produces a new run, never an edit |
| Forbidden content | No secret, token, password, IP address, user agent or personal data beyond pseudonymous identifiers. A secret seen in evidence is an incident |
| Location | Detailed Production evidence lives in the operator's private evidence store. The public repository holds summaries, closures and index hashes. Unfixed security findings are never in the public repository |
| Retention | **Production gate evidence: 7 years** (operator decision, 2026-10-17). CI evidence: as kept by the CI provider |
| Evidence store | A dedicated, EU-hosted, **immutable (WORM)** store with version-level immutability, separate from the backup store and from every application credential. Designed; created only through its own cost and security gate (amendment 1) |
| Encryption | **age encryption is mandatory**, to **two independent recipients**: the operator's, and a recovery recipient held offline. The **detailed manifest and the evidence payload are age-encrypted**. Only a **minimal outer integrity manifest** may stay in clear, so that integrity can be checked without decrypting: run ID, digests and sizes of the encrypted files, dates (amendment 1) |
| Immutability lock | A trial phase with the immutability policy **unlocked** comes first. Locking the policy (irreversible) is a **separate operator decision** (amendment 1) |
| Access | **Workload identity or Microsoft Entra authentication is preferred.** **No long-lived SAS.** When a SAS is indispensable: a short-lived **user-delegation** SAS only, with minimal permissions, issued for the operation and **never stored**. **Shared Key access disabled** if the final architecture allows it (amendment 1) |
| Reproducibility | A claim names the exact commit, deployment, database branch and time (UTC) |

## 13. Migration assurance

Codifies the practice already proven in F2, F3 and F4. Every migration:
1. Is **expand-only** by default; one migration per change, named, with its purpose in a header comment.
2. Sets `lock_timeout` and states its locking effect.
3. New tables: **FORCE row-level security** with policies, append-only triggers where they hold records, and no `DELETE` or `TRUNCATE` for `app_user` unless designed.
4. New functions:
   - `REVOKE ALL … FROM PUBLIC` right after the body;
   - pinned `search_path`;
   - `SECURITY DEFINER` only when justified;
   - grants to `app_user` listed, mirrored in the CI bootstrap, and held by the function-privilege gate.
5. Avoids constructs that do not survive dump and restore identically (for example `BETWEEN` in a CHECK). The CI backup round trip proves it.
6. Has a **rollback script** that refuses when in use, and a **CI drill** (exact restore, refusal, re-apply).
7. Is **rehearsed on a fresh clone of Production** (section 9b) before its gate, then applied by a **gate** (section 10). The next backup is verified, with its counts of tables and migrations.
8. Is never edited after it ran in any shared environment. Corrections are new migrations.

## 14. Supply-chain security

| Requirement | Rule |
|---|---|
| Lockfile | Committed; CI installs with `npm ci` only |
| Dependency changes | A new dependency in class A is part of its review: its necessity, maintainer health, licence and install scripts |
| Vulnerability management | Automated dependency vulnerability alerts and a written fix policy by severity (target delays to be set by the operator) |
| CI actions | Third-party actions **pinned to a full commit SHA**; workflow tokens with least privilege (`permissions:` set explicitly) |
| Secrets in CI | Only in the CI secret store, scoped per environment; never printed; Production secrets never available to pull-request workflows |
| Secret scanning | Repository secret scanning and push protection on |
| Branch integrity | The default branch is protected: changes only through reviewed PRs, required status checks, no force-push |
| Build provenance | Every Production deployment records the exact commit, and the deployment ID is kept as the rollback target |
| SBOM | A software bill of materials produced per release, for customers who ask (target: before the commercial beta) |
| Third-party services | An inventory of services in the trust chain (hosting, database, CI, identity providers, vault) with their region and role: the registry (section 6) |

## 15. SLO/SLI framework

The [service-level register](SERVICE-LEVEL-REGISTER.md) defines each SLI with:
- its exact measurement;
- its data source;
- the window;
- the SLO target;
- the alert threshold;
- the runbook.

**Rules:**
- **No SLO is binding until its SLI is measured.** Targets stay PROPOSED until 30 days of measurement exist. Then the operator sets them.
- Correctness objectives are absolute, not budgets. Examples: zero cross-tenant reads, 100% of sessions with sign-in evidence, zero journal edits.
- **Error budget policy:** when an availability budget is exhausted, class B work stops until reliability work restores it. Class A security fixes always proceed.
- Every SLO has an alert that reaches a human, and that alert path is tested (section 17).
- SLOs are reviewed monthly, and after every S1 or S2 incident.

## 16. Incident severity and runbooks

Severity follows [`INCIDENT-RESPONSE-AND-BREACH-NOTIFICATION.md`](../legal/INCIDENT-RESPONSE-AND-BREACH-NOTIFICATION.md) section 1, extended with S4:

| Level | Definition | Response targets |
|---|---|---|
| **S1, critical** | Cross-organization or external data exposure; unauthorized administrator access; loss of the database; an invariant broken in Production | **Acknowledged within 15 minutes; owner assigned within 30 minutes; containment or rollback started within 1 hour** (operator decision, 2026-10-17) |
| **S2, major** | Service down; sign-in impossible for an organization; a security control found ineffective | **Acknowledged within 1 hour; containment started within 4 hours** (operator decision, 2026-10-17) |
| **S3, minor** | Degraded service; a vulnerability without evidence of use | Fix planned within 7 days (PROPOSED) |
| **S4, informational** | Near miss, false alarm, or a weakness found by review or test before any impact | Recorded; reviewed at the next monthly review (PROPOSED) |

**These targets are not guaranteed until an on-call is operational.** Today there is one operator and no on-call rotation.

**Requirements:**
- Every S1 and S2 scenario has a **runbook** ([template](templates/INCIDENT-RUNBOOK-TEMPLATE.md)) with detection, containment, recovery, verification and communication steps. Each runbook is **exercised at least once a quarter**, as a tabletop or on a clone.
- **Containment is not remediation.** An incident closes only when the cause is fixed and verified, not when the harm stops.
- Every S1 or S2 incident gets a written post-incident review within 5 working days: timeline, cause, what detected it, what failed, and actions with owners. Its actions are tracked to closure.
- The targets assume someone reachable at all times. The present single-operator capacity is a recorded gap (gap analysis).

## 17. Definition of OPERATIONALLY PROVEN

Operator definition (2026-10-17, completed by amendment 1). A change, or a capability, already **PRODUCTION VERIFIED** (and not demoted since) is **OPERATIONALLY PROVEN** when all six hold:
1. **At least 30 days** in Production.
2. **Predefined scenarios and volume** observed. They are written in its gate before release (for example the sign-in paths and a number of real sign-ins through each). A path never exercised is not proven.
3. **Alert path tested.** An alert on its failure modes reached a human, whether real or synthetic, and was acknowledged.
4. **Runbook exercised.** The runbooks for its failure modes were exercised after release, as a tabletop or on a clone.
5. **Recovery repeated after release.** Its rollback, or the restore that covers its data, was rehearsed again after release.
6. **Required SLIs measured continuously** throughout the observation period, **without a significant gap** (amendment 1).
   - The required SLIs are those its gate names, taken from the [service-level register](SERVICE-LEVEL-REGISTER.md).
   - A **significant gap** is either of the following (operator decision, 2026-10-17):
     - **one uncovered interval longer than 15 minutes**;
     - **uncovered intervals totalling more than 0.1% of the window**.
   - An interval counts as **covered** when an **independent, equivalent telemetry** measured the same SLI during it.
   - **Planned maintenance without replacement telemetry counts as a gap.**
   - A significant gap restarts the observation period for the affected SLI.

As for every state (section 2), each point needs its evidence, and the state is lost when that evidence stops being true. An attributable S1 or S2 incident, for example, demotes the item.

## 17b. Private Beta entry gate (amendment 3)

Operator decision, 2026-10-18.
- **The Private Beta does not require OPERATIONALLY PROVEN.** OPERATIONALLY PROVEN (section 17) is accumulated during the Private Beta, and is required before general availability (GA) for every capability in the GA scope.
- The first limited pilot starts only when **all eight criteria** below hold. The gate is all or nothing. It is recorded with the [Production gate template](templates/PRODUCTION-GATE-TEMPLATE.md) and decided by the operator.
- The **Beta scope** is written and approved by the operator before the gate. It names the pilots' profile, the capabilities and sign-in flows they use, and the legal, retention and hosting requirements that apply to them.

| # | Criterion | What it requires |
|---|---|---|
| G1 | Beta-critical capabilities are PRODUCTION VERIFIED | Every capability the Beta scope names is PRODUCTION VERIFIED and not demoted (section 2) |
| G2 | Every relevant class A change is INDEPENDENTLY REVIEWED | Relevant: every class A change a Beta-critical capability depends on. This includes those already PRODUCTION VERIFIED (assurance debts, section 18) and those merged under an exception |
| G3 | No unresolved critical security finding affects the Beta scope | Critical: a finding that could cause an S1 or S2 incident (section 16). Unresolved: not fixed and verified. A critical finding is not closed by acceptance |
| G4 | The Production rollback and recovery path is verified | The database restore **and** the switch of the application to the restored database are rehearsed on the platform the pilots use: within 90 days before the gate, and again after any change of platform or region |
| G5 | The required gate evidence is current | Each Beta-critical capability has its sealed gate evidence (section 12) for the commit deployed at the time of the gate |
| G6 | Minimum application monitoring is active | At least: availability of the sign-in page and of the API, checked from outside the hosting platform; server errors (5xx); database availability; sign-in success (SLI-01); backup freshness (SLI-05) |
| G7 | The human alert path has been tested end to end | For each G6 signal, an alert (real or synthetic) reached the operator through a channel outside the monitored platform and was acknowledged, with the times recorded |
| G8 | The legal, retention and hosting blockers applicable to the pilot are closed | As listed in the Beta scope: the documents the pilot signs reviewed by counsel; retention and deletion enforced for the data the pilot creates; a hosting tier and region allowed for the pilot's use |

**Generic OIDC (F4).** F4 is not a blocker for the first pilots if they use only supported Microsoft Entra or passkey flows. A flow is supported when it is PRODUCTION VERIFIED for the connection type and configuration the pilot will use. F4 becomes a gate before broader provider-neutral expansion.

## 18. Transition from the current practice

- Items already PRODUCTION VERIFIED keep that state. Their missing intermediate states are recorded as **assurance debts** in the gap analysis. They are not repaid by relabelling.
- Work in progress adopts this standard at its next state change. F4 slices S1 to S5 are IMPLEMENTED. Before INDEPENDENTLY REVIEWED and any gate, they need:
  - a threat model;
  - a traceability table;
  - an independent review.
- Design documents in `docs/architecture/` remain valid as RFCs. Decisions are extracted to ADRs as they are touched.

## 19. Ownership and amendment

- The operator owns this standard. Amendments are class C changes with the operator's approval, recorded with their date.
- An exception to any rule is written, approved by the operator and time-limited, and recorded in the **exception register** of the gap analysis.
- When an exception ends (expired, closed or revoked), it **stays in the register**. Its entry gives its state, the date and time (UTC) it ended, and the reason. An exception is never deleted from the register.

| Amendment | Date | Decided by | Change |
|---|---|---|---|
| 1 | 2026-10-17 | Operator | OPERATIONALLY PROVEN also requires the required SLIs measured continuously, without a significant gap: no uncovered interval over 15 minutes and no more than 0.1% uncovered in total; independent equivalent telemetry may cover an interval; planned maintenance without replacement telemetry is a gap (section 17, point 6). Evidence store: mandatory age encryption to two independent recipients (detailed manifest and payload encrypted, only a minimal outer integrity manifest in clear); 7-year retention of gate evidence; WORM, with an unlocked trial and then a lock by separate decision; workload identity or Entra preferred; no long-lived SAS, a short user-delegation SAS only if indispensable; Shared Key disabled if the architecture allows it (section 12). No resource is created by this amendment |
| 2 | 2026-10-18 | Operator | Ended exceptions (expired, closed or revoked) stay in the exception register with their state, the date and time they ended, and the reason; none is deleted (this section, and the gap analysis section 3b) |
| 3 | 2026-10-18 | Operator | Private Beta entry gate: eight criteria (G1 to G8) before the first limited pilot; OPERATIONALLY PROVEN not required for the Private Beta, required before GA; generic OIDC (F4) not a blocker for first pilots that use only supported Entra or passkey flows, a gate before broader provider-neutral expansion (section 17b) |
