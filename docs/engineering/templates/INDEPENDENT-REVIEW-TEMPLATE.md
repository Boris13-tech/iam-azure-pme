# Independent review: <change>

| Item | Value |
|---|---|
| Change, class | |
| Commit range reviewed | `base..head` (full SHAs) |
| Author | person or AI agent (and session) |
| Reviewer | name and competence. Not the author; a human for class A when the author is an AI agent |
| Complementary reviews | for example an AI review by another model; complementary only |
| Date | |

## Checklist
| Area | Question | Result | Notes |
|---|---|---|---|
| Invariants | Does any change weaken I1–I7? Is each touched invariant named, with evidence? | | |
| Boundaries | Is every boundary crossed in the registry, with its controls? | | |
| Threat model | Does each threat have a mitigation and a test? Are residual risks accepted by the operator? | | |
| Adversarial tests | One test per refusal? Replay, race, cross-tenant, outage, mix-up? Do the tests fail without their control? | | |
| Authorization | Permission checked before any side effect or outside call? Server-derived scope only? | | |
| Data and migrations | Expand-only? RLS forced? Function privileges? Rollback drilled? Stable under dump and restore? | | |
| Secrets and logs | No secret, token, IP or user agent in code, logs, payloads, evidence? | | |
| Failure behaviour | Fail closed? Generic answers? Existing sessions unaffected by outages? | | |
| Supply chain | New dependency justified? Actions pinned? Workflow permissions minimal? | | |
| Operability | Journal events and labels? SLIs and alerts? Runbook updated? | | |
| Gate (when reviewing a gate) | Preconditions, confirmation tokens, refusal on drift, rollback triggers, real-scenario proofs | | |

## Findings
| ID | Severity (blocking / major / minor / note) | Finding | Resolution (commit) or operator acceptance (date) |
|---|---|---|---|

## Verdict
Approved / Approved with conditions / Changes required. A class A change is not merged while a blocking finding is open.
