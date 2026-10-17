# LUXIA Mission-Critical Engineering Standard v1

| Item | State |
|---|---|
| Status | **PROPOSED** (draft PR). It applies once the operator approves it. Until then, the existing practice (section 18) stays in force |
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

> **The wording is PROPOSED.** This repository did not record a list of "seven superior invariants". The seven below are **derived** from rules already decided and enforced: the sovereign design rules R1 to R10, T0, the F2 and M2 phases, F3, the B-series and E1. **The operator must confirm or amend them** (approval required).

| # | Invariant | Derived from | Enforced today (VERIFIED) |
|---|---|---|---|
| **I1** | **Authority is LUXIA's alone.** Only an explicit, scoped, journaled and revocable LUXIA decision grants access. No provider claim, group, synchronization or automation creates or extends authority | R1, R6 | Architecture tests: no adapter writes authority tables. Route tests: claims change nothing (F4 S4) |
| **I2** | **Isolation is enforced by the database.** No organization reads or writes another's data. The application's scope is never trusted alone | R7, M2 | FORCE row-level security on tenant tables; app_user has NOBYPASSRLS; RLS suites across organizations in CI |
| **I3** | **Fail closed, answer generically.** Unknown, invalid, ambiguous or failing input refuses. An infrastructure failure denies, it never allows. Refusals reveal nothing to the browser | R8, B3 | Negative test tables (R8). The authorization gateway denies on error. Login answers are identical for unknown and refused cases |
| **I4** | **No security action without evidence. Evidence is append-only.** Every security decision leaves a record. No record means no action (for example, no session without its sign-in evidence). Records are never updated or deleted | T0, W1/W2, R9 | Append-only triggers on the journal, sign-in evidence and test runs. The session and evidence are written in one transaction |
| **I5** | **Secrets are referenced, never exposed.** No secret in code, logs, payloads, responses or shared global configuration. Production reads provider secrets by reference from a vault | F3, operator rules | Secret references only (database CHECKs); secret leases redact themselves; tests assert that errors carry no secret. *Vault not wired yet (F3 steps 1–7, gated)* |
| **I6** | **Continuity: no lock-out, no silent data loss.** Local sign-in and recovery never depend on an external provider. A provider outage never revokes a session. Backups are independent, verified and restorable | R3, R5, B2/B4, E1 | LUXIA_LOCAL always ACTIVE (database guard); break-glass procedure; hourly independent backup with CI round-trip restore. *A 4-hour RPO is not guaranteed until external alerting and catch-up are operational* |
| **I7** | **Every change is gated and reversible.** Changes reach Production only through gates, with a rehearsed rollback or an approved forward-only plan, and an exact record of what was deployed. A provider is replaceable without touching authority | R10, F2/F3 gates | Expand-only migrations with rollback scripts and CI drills; gate tools with sealed evidence (kept outside the repository); exact-commit deployments |

**Every PR that touches an invariant names it**, in its description and its threat model, with the evidence that it still holds.

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
| Retention | Production gate evidence: at least the life of the system plus one year (operator to confirm). CI evidence: as kept by the CI provider |
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

| Level | Definition | Response objective (PROPOSED) |
|---|---|---|
| **S1, critical** | Cross-organization or external data exposure; unauthorized administrator access; loss of the database; an invariant broken in Production | Containment started within 1 hour of detection; operator engaged immediately |
| **S2, major** | Service down; sign-in impossible for an organization; a security control found ineffective | Containment within 4 hours |
| **S3, minor** | Degraded service; a vulnerability without evidence of use | Fix planned within 7 days |
| **S4, informational** | Near miss, false alarm, or a weakness found by review or test before any impact | Recorded; reviewed at the next monthly review |

**Requirements:**
- Every S1 and S2 scenario has a **runbook** ([template](templates/INCIDENT-RUNBOOK-TEMPLATE.md)) with detection, containment, recovery, verification and communication steps. Each runbook is **exercised at least once a quarter**, as a tabletop or on a clone.
- **Containment is not remediation.** An incident closes only when the cause is fixed and verified, not when the harm stops.
- Every S1 or S2 incident gets a written post-incident review within 5 working days: timeline, cause, what detected it, what failed, and actions with owners. Its actions are tracked to closure.
- Response objectives assume an operator who is reachable. The present single-operator capacity is a recorded gap (gap analysis).

## 17. Definition of OPERATIONALLY PROVEN

A change, or a capability, is **OPERATIONALLY PROVEN** when **all** of the following hold, each with evidence:
1. It has been **PRODUCTION VERIFIED** and has not been demoted since.
2. **Observation window:** at least **30 days** in Production (PROPOSED; the operator may set a longer window per class), **and** at least the minimum number of real uses defined in its gate (for example a number of real sign-ins through the path). A path never exercised is not proven.
3. **Measured service level:** its SLIs (section 15) were measured over the window and met their SLOs. For correctness objectives, zero violations.
4. **Alerting proven:** an alert on its failure modes reached a human at least once, whether real or synthetic, and was acknowledged.
5. **Runbook exercised:** the runbooks for its failure modes were exercised after release, as a tabletop or on a clone.
6. **Recovery proven after release:** its rollback, or the restore that covers its data, was rehearsed on current Production data after release.
7. **No attributable S1 or S2 incident** during the window, and no open review finding or accepted risk past its due date.
8. **Independent review** recorded (section 8); for changes released before this standard, a retroactive review.
9. **Sealed evidence** of points 1 to 8, and the operator's written acceptance.

## 18. Transition from the current practice

- Items already PRODUCTION VERIFIED keep that state. Their missing intermediate states are recorded as **assurance debts** in the gap analysis. They are not repaid by relabelling.
- Work in progress adopts this standard at its next state change. F4 slices S1 to S5 are IMPLEMENTED. Before INDEPENDENTLY REVIEWED and any gate, they need:
  - a threat model;
  - a traceability table;
  - an independent review.
- Design documents in `docs/architecture/` remain valid as RFCs. Decisions are extracted to ADRs as they are touched.

## 19. Ownership and amendment

- The operator owns this standard. Amendments are class C changes with the operator's approval, recorded with their date.
- An exception to any rule is written, approved by the operator, time-limited, and listed in the gap analysis until it expires.
