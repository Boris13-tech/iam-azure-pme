# Service-level register (SLIs and SLOs)

Standard, section 15.

| Item | State |
|---|---|
| Targets | **PROPOSED, not binding.** No SLO binds until its SLI has been measured for 30 days; then the operator sets it |
| OPERATIONALLY PROVEN | Requires the SLIs named in the gate to be measured **continuously** over the whole observation period, without a significant gap (standard, section 17, point 6) |
| Measurement today | Mostly **MISSING**: there is no automated monitoring yet (recorded in `docs/legal/INCIDENT-RESPONSE-AND-BREACH-NOTIFICATION.md`). Backup freshness is the exception (E4) |

## Availability and latency

| ID | SLI (exact measurement) | Source (to build unless stated) | Window | Proposed SLO | Alert | Runbook |
|---|---|---|---|---|---|---|
| SLI-01 | Sign-in success: completed sign-ins ÷ sign-in attempts that should succeed (excluding unknown organization, wrong credential, user cancel), per method (federated, passkey, recovery) | Sign-in evidence (VERIFIED / REJECTED with reason codes) plus request logs | 30 days rolling | 99.5% per method | Burn rate over 1 h and 6 h | Provider outage; Database outage |
| SLI-02 | Sign-in latency: p95 from the callback or assertion request to the session cookie | Request timing logs | 30 days | p95 < 2 s (federated), < 1 s (passkey) | p95 over target for 15 min | Failed deployment |
| SLI-03 | Session resolution availability: authenticated requests answered without a 5xx caused by session resolution | Application logs | 30 days | 99.9% | 5xx rate | Database outage |
| SLI-04 | Administrator API availability: canonical API requests without 5xx | Application logs | 30 days | 99.5% | 5xx rate | Failed deployment |
| SLI-05 | Backup freshness: time since the last verified encrypted backup | Backup inventory, freshness alert (**exists, E4**) | Continuous | < 2 h (target RPO 4 h is **not guaranteed** until external alerting and catch-up are operational) | Freshness alert (exists) | Backup restore |
| SLI-06 | Restore time: from decision to a verified restored database on a drill | Restore drills | Per drill (at least quarterly) | < 4 h | Missed drill | Backup restore |

## Correctness objectives (absolute, not budgets)

| ID | Objective | How it is checked | On violation |
|---|---|---|---|
| COR-01 | Zero cross-organization reads or writes (I2) | RLS suites in CI; periodic read-only isolation check in Production (to build) | S1 incident |
| COR-02 | 100% of sessions have their sign-in evidence (I4) | Read-only reconciliation: sessions without evidence (to build) | S1 incident |
| COR-03 | Zero edits or deletions of journal and evidence rows (I4) | Append-only triggers; periodic digest of counts (to build) | S1 incident |
| COR-04 | Zero authority changes not traceable to a journaled LUXIA decision (I1) | Authority digest reconciliation (exists for gates, to automate) | S1 incident |
| COR-05 | Zero secrets in logs, evidence or responses (I5) | Tests; secret scanning; log sampling (to build) | S1 or S2 incident, plus rotation |

## Error-budget policy

- When an availability budget is exhausted, class B work stops until reliability work restores it.
- Class A security fixes always proceed.
- A budget is reviewed monthly, and after every S1 or S2 incident.
