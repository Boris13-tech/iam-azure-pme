# LUXIA Identity — NEXT TASK

Read `docs/handoff/CURRENT-STATE.md` first.

## Completed (2026-10-10)

- RESOURCE ACCESS ONBOARDING V1 — PRODUCTION END-TO-END CERTIFICATION: PASS.
- DASHBOARD V1 — PRODUCTION CERTIFICATION: PASS (Production `dpl_48xvYWVVJUiZg1k9A53tyD7yf7tu` @ `5c71df8`).

## Next objective (operator roadmap, Phase 3: Customer Self-Onboarding)

Write a **scope proposal**, docs only, for customer self-onboarding:

> Create Organization → Create Tenant → Verify Domain → Establish First Admin → Configure Auth → Connect Provider → Invite Team → Register Resources → Define Entitlements → Assign Access → Configure Governance

The goal is no manual SQL, no Neon access and no operator script for a normal onboarding. The proposal must cover the threat model for first-admin establishment (domain proof, invitation, optional approval) and must not weaken RLS, default deny, or the "no implicit first owner" invariant.

Optional small follow-ups (separate PRs, each needs approval): the dashboard minor items listed in `docs/certification/DASHBOARD-V1-PRODUCTION-2026-10-10.md`.

## Allowed

- Review, documentation, non-mutating verification, scope proposals.

## Forbidden

- Implementation before the scope is approved.
- Any Production grant, Assignment creation or business-data mutation.
- Merging, deploying, or changing env vars/migrations without explicit human approval.
- Any change to PR12.
- Replaying any manifest. `e2db9550` is completed; `7d1d9a7d`, `2f110998` and `95e9b80d` are abandoned.

## Success criteria

The scope proposal is approved by the operator.

## Stop condition

STOP after the proposal is written, and wait for approval before any code.
