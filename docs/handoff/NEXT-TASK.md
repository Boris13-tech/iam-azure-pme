# LUXIA Identity — NEXT TASK

Read `docs/handoff/CURRENT-STATE.md` first.

## Completed (2026-10-10)

PR #16 was promoted and merged (`8acea18`). Merge-SHA CI PASS. Exact-SHA Production deployment `dpl_J3GnuWwpMFejURjG5ASKWc8nJK5U` READY. Unauthenticated HTTP smoke PASS. Read-only Production DB preflight PASS (bootstrap Assignment count 0, protected capability DENY).

## Also completed (2026-10-10)

Production authenticated smoke: all 4 steps OK (OPERATOR-REPORTED).

## Next objective

Prepare the Production first-owner ceremony session. This needs **explicit human approval to start**.

Constraints for that session:
- The manifest validity window is ≤ 1 hour. Generate it only at the start of a session where the operator is available for the whole hour.
- Before generating, re-run the read-only preflight: count 0, DENY, Subject ACTIVE, SoD no conflict, binding exact, and Production deployment still `dpl_J3GnuWwpMFejURjG5ASKWc8nJK5U` / `8acea18`.
- The manifest needs a new assignmentId, operationId, validFrom and binding, and validUntil ≤ validFrom + 1 h. It also needs a release artifact binding the Vercel deployment ID and SHA.
- After generation, STOP and present the exact bytes and digests for **explicit human approval**.
- The ceremony (`scripts/operators/run-production-resource-bootstrap.ts <manifest> <approval> --browser-evidence`) is run by the operator, with browser evidence. Each probe must be answered within 90 seconds.

## Allowed

- Review, documentation, and non-mutating verification (GitHub/CI/Vercel reads, HTTP GETs, read-only preflight via `scripts/operators/production-resource-preflight.ts`).

## Forbidden

- Any Production grant, Assignment creation or business-data mutation.
- Manifest generation before the authenticated smoke passes. After it passes, generate a manifest only per section 11 of CURRENT-STATE, then STOP for explicit human approval.
- Reusing, editing or re-timestamping any old manifest/approval.
- Merging any PR without explicit human approval.
- Any change to PR12.
- Starting a new product slice.
- Environment variable changes, migrations, or Production deploys without explicit human approval.

## Success criteria

- Session start explicitly approved by the human operator.
- Manifest generated, revalidated and explicitly approved, then the ceremony completes: DENY → one bounded grant → ALLOW → replay idempotent → modified replay DENY → revoke → DENY → no recreation.
- No scope broadening.

## Stop condition

STOP before manifest generation, and again before the ceremony. Each step requires its own explicit human approval. Never infer PASS.
