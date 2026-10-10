# LUXIA Identity — NEXT TASK

Read `docs/handoff/CURRENT-STATE.md` first.

## Completed (2026-10-10)

PR #16 was promoted and merged (`8acea18`). Merge-SHA CI PASS. Exact-SHA Production deployment `dpl_J3GnuWwpMFejURjG5ASKWc8nJK5U` READY. Unauthenticated HTTP smoke PASS. Read-only Production DB preflight PASS (bootstrap Assignment count 0, protected capability DENY).

## Next objective

Production **authenticated** smoke on `8acea18`, performed by the human operator in a browser:

1. Entra login reaches the dashboard.
2. Pages render: `/dashboard/users` (JML), `/dashboard/resources`, `/dashboard/governance/sod`, `/dashboard/governance/access-reviews`, `/dashboard/resources/onboarding`.
3. `GET /api/resources/protected-resource-demo` returns 403 `RESOURCE_ACCESS_DENIED` with an `evidenceId`.
4. Sign out, then LUXIA_LOCAL passkey login reaches the dashboard.

Expected side effects: new Session rows and one `RESOURCE.CAPABILITY.READ` DENIED audit event. No authorization state change.

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

- The authenticated smoke passes, and the operator's observations are recorded in CURRENT-STATE.
- A re-run of the read-only preflight still shows bootstrap Assignment count 0 and DENY.
- No scope broadening.

## Stop condition

STOP after recording the authenticated smoke result. Manifest generation and the Production ceremony each require their own explicit human approval. Never infer PASS.
