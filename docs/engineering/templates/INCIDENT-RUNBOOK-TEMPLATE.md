# Runbook: <scenario>

| Item | Value |
|---|---|
| Severity when it occurs | S1 / S2 / S3 (standard, section 16) |
| Invariants at stake | I1–I7 |
| Last exercised | date, form (tabletop / clone / real), result |
| Owner | |

## Detection
The signal that reveals it (alert, SLI, customer report, journal pattern), and where to look first. If there is no automated signal yet, say so.

## Immediate safety (first 15 minutes)
The narrowest action that stops the harm, with the exact tool and its confirmation step. Containment is not remediation.

## Diagnosis
Read-only checks first (READ ONLY transactions in Production), the questions to answer, and the evidence to keep.

## Recovery
Steps to restore normal service. Each step has its proof that it worked.

## Verification
How to show that the invariants hold again: digests, isolation checks, sign-in proofs.

## Communication
Who is told (operator, affected customer administrators, authority when the law requires it), when, through which channel, and with which template.

## Closure
- Cause fixed and verified.
- Post-incident review written within 5 working days for S1 and S2.
- Actions tracked, with owners.
- Runbook updated with what was learned.
