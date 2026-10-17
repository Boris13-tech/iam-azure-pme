# Production gate: <change>

| Item | Value |
|---|---|
| Change, class | |
| Exact commit (reviewed) | full SHA |
| Rehearsed code, rehearsal run | commit; run ID and index hash |
| Independent review | record link |
| Rollback target (code) | current Production deployment ID |
| Rollback (data) | script, lossless window, refusal when in use, drill evidence |
| Operator "go" | date, time (UTC), exact words |

## A. Preconditions (all required, each with evidence)
| # | Precondition | Evidence |
|---|---|---|
| 1 | Full CI green on the exact commit (all jobs, backup round trip included) | run ID |
| 2 | Independent review recorded, no open blocking finding | |
| 3 | Fresh-clone rehearsal passed, 0 failures, evidence sealed | index hash |
| 4 | Gate tool tested on a disposable clone (dry run), clone deleted after evidence | |
| 5 | A backup taken and verified (counts of tables and migrations) just before | backup ID |
| 6 | BEFORE state equal to the rehearsal's BEFORE (data, schema, definitions digests) | |
| 7 | Rollback triggers written (section C) | |
| 8 | Real-scenario proofs prepared (who does what, with which account; never a test account in Production) | |

## B. Steps
Each Production write is behind an explicit confirmation token and refuses if data, definitions or code differ from the rehearsal.

| # | Step | Command / tool | Confirmation | Expected | Evidence file |
|---|---|---|---|---|---|

## C. Rollback triggers (decided in advance)
- Any failed check before closure triggers an immediate rollback, following section D.
- List here the specific signals: an error rate, a failed proof, a digest mismatch.

## D. Rollback procedure
Steps, expected duration, the proofs after rollback, and when it stops being lossless.

## E. After-checks and real-scenario proofs
| # | Check | Expected | Result | Evidence |
|---|---|---|---|---|

## F. Closure
- Next scheduled backup verified.
- Evidence sealed (index hash).
- State set to PRODUCTION VERIFIED.
- Observation period started toward OPERATIONALLY PROVEN: window, real uses required, SLIs watched.
- Closure note path.
