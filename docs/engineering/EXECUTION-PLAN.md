# Execution plan (continuous)

| Item | State |
|---|---|
| Purpose | One page that says, for every open workstream: where it stands, what "done" means in verifiable terms, the evidence, what it depends on, and which human gate it waits for. Kept current at each working session. The Beta gate itself stays in [PRIVATE_BETA_READINESS.md](../../PRIVATE_BETA_READINESS.md) |
| Updated | 2026-10-29 |
| Production | `dpl_Fd1NttL6FHumdR9THjwkeR3wkRR8`, commit `464c265` (2026-10-25, operator-approved; [change record](../operations/PRODUCTION-CHANGE-RECORD.md)). Checked 2026-10-29 20:42 UTC: `/login` serves LUXIA |

Labels: **DONE** (evidence exists), **IN REVIEW** (PR open, CI green, waiting for a reviewer or the operator), **IN PROGRESS**, **BLOCKED** (by what), **TODO**.

## 1. Workstreams

| # | Workstream | State | Acceptance criteria (verifiable) | Evidence / PR | Depends on | Human gate |
|---|---|---|---|---|---|---|
| W1 | Production change governance (GOV-001) | IN REVIEW | Every Production change goes through `production-deploy.yml`; its run shows the operator's GitHub approval, the SHA, the deployment and the after-checks | #136; change record with the two 2026-10-25 approvals (hashed copies in the private evidence store) | — | Review; operator adds `VERCEL_DEPLOY_TOKEN` and three variables to the Production environment |
| W2 | Monitoring and alerting (G6, G7) | IN REVIEW | An outside check alerts the operator within 5 min when `/login` does not serve LUXIA; one recorded alert test per signal (M-A to M-E) | #133 (canary), #102, #108, runbooks merged (#131) | — | Operator creates the free UptimeRobot monitor; merges of class A |
| W3 | Dashboard V2: professional desktop and mobile experience | IN REVIEW | Every page: loading, error with retry, refusal and empty states distinct; no identifier typed or shown to a user where a name exists; menu usable by keyboard and on a 375 px screen; at most two concurrent API requests per page; checked as an administrator and as a member on a local database with fictional data | #134 (brand, sign-in), #135 (shell, mobile, accessibility, governance pages); tests `brand-and-auth-shell`, `app-shell`, `dashboard-states` | — | Review (class B); deployment by W1 |
| W4 | Passkey journeys tested end to end | IN PROGRESS | Sign-up, sign-in, sign-out, recovery codes and recovery session, invitation, refusals: green in CI with a virtual authenticator; a real-device checklist run by the operator on Production | Agent branch `test/e2e-passkeys` (draft PR to come) | — | The operator's own devices for the real-device checklist |
| W5 | Retention and deletion R1 to R8 (G8) | IN PROGRESS | Each mechanism: bounded, journaled or counted, rehearsed on a Production clone, rollback proven; periods agreed with counsel | R1 #107, R2 #126, R3 #127, R7 #128, R4/R6 (agent branch, stacked on R7), R8 #130; R5 TODO (stacked after R4/R6: it changes the same journal guard) | R4/R6 and R5 depend on R7 | Independent review; counsel's periods; #130 decision on the stated backup period; Production migrations |
| W6 | Backups off GitHub-hosted runners | IN REVIEW | 24 consecutive hourly backups from the Azure job, a restore drill from one of them, GitHub job switched off and its secrets deleted | #132 (image build proven in CI) | — | Review; operator steps of the cutover (provider registration, vault secret, deployment) |
| W7 | CI/CD and authorization hardening | IN REVIEW | #89, #91, #86 merged in that order; `main` protected; #101 merged | Threat models in the PRs | — | Independent human reviewer (G2) |
| W8 | Signup codes behind a confirmation | IN REVIEW | Issuance needs a plan, its digest, the same database and commit; single use | #121 | — | Review |
| W9 | Production in the EU (G4 after the move) | BLOCKED | Production in Frankfurt; restore drill repeated there | #104, EU runbook | W1 (deploy path) | Operator: Production migration and switch |
| W10 | Legal minimum (G8) | BLOCKED | Counsel review of the pilot agreement, DPA, privacy notice; the entity exists | `docs/legal/` | — | Operator: counsel, entity, budget |

## 2. Open findings from 2026-10-29 (not yet in a PR)

| Finding | Severity | Next step |
|---|---|---|
| Reviewers without the right to read people see "name not visible" in access review items | Medium (product) | Server returns labels for items the reviewer may read (class A task prepared) |
| A duplicate scope key answers 500 instead of a clear refusal | Low | Task prepared (409 with a specific code) |
| A new review campaign shows no creation event in its history | Low (audit visibility) | Task prepared (class A: journal reading path) |
| Without `AUTHZ_MODE`, authorization silently falls back to `legacy` | Medium | #91 makes it fail closed (in review). Production has the variable set (name verified) |

## 3. Critical path

1. **A human reviewer** (G2): every class A change waits for it. Call for volunteers: issue #122.
2. **W1 then W2**: a traceable deploy path, then monitoring that would have caught the 2026-10-24 incident.
3. **W5 and W6**: the G8 data mechanisms and the backup DPA gap.
4. **W9 and W10**: EU, counsel, entity.
5. W3 and W4 run alongside; they need no gate until deployment.

## 4. How this page is kept true

- A line moves to DONE only with its evidence (a merged PR, a run URL, a sealed record).
- Any Production action is listed in the [change record](../operations/PRODUCTION-CHANGE-RECORD.md) with its approval evidence before it is reported done.
