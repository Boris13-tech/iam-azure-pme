# LUXIA Identity — NEXT TASK

Read `docs/handoff/CURRENT-STATE.md` first.

## Completed (2026-10-10)

**RESOURCE ACCESS ONBOARDING V1 — PRODUCTION END-TO-END CERTIFICATION: PASS** (manifest `e2db9550…`, evidence in `docs/certification/RESOURCE-ACCESS-PRODUCTION-E2E-2026-10-10.md`). The Resource Access tranche is closed.

## Next objective

1. Repo hygiene PR (small, separate): fix the tracked `" README.md"` (leading-space filename) that breaks Windows checkouts. Docs/repo only.
2. Then wait for the operator to choose and approve the scope of the first productization slice. The planned first slice is the Enterprise Identity Security Dashboard ("Identity Security Posture": Identities, Sessions, Access, Resources, Governance, Security Activity), using real canonical backend data only, with no fake scores.

## Allowed

- Review, documentation, non-mutating verification.
- The hygiene PR above.
- Proposals and designs for the next slice (no implementation until its scope is approved).

## Forbidden

- Any Production grant, Assignment creation or business-data mutation.
- Replaying any manifest. `e2db9550` is completed; `7d1d9a7d`, `2f110998` and `95e9b80d` are abandoned.
- A second initial bootstrap on entitlement `d6605f22-…`.
- Merging, deploying, or changing env vars/migrations without explicit human approval.
- Any change to PR12.
- Implementing a new product slice before its scope is explicitly approved.

## Success criteria

- Hygiene PR merged, with CI PASS on the exact SHA.
- Next slice scope written down and approved by the operator.

## Stop condition

STOP after the hygiene PR is ready (merge needs approval), and again before any implementation of a product slice.
