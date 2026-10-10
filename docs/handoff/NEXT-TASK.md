# LUXIA Identity — NEXT TASK

Read `docs/handoff/CURRENT-STATE.md` first.

## Completed (2026-10-10)

- Resource Access Onboarding v1: Production E2E PASS.
- Dashboard v1: Production certification PASS.
- Security Journal v1: Production certification PASS (`dpl_EDZXLTXRrHDbBbVGqcEhCTF3SnpW` @ `2d7ec62`).

## Next objective (operator roadmap: Customer Self-Onboarding)

Write a **scope proposal**, docs only:

> Create Organization → Create Tenant → Verify Domain → Establish First Admin → Configure Auth → Connect Provider → Invite Team → Register Resources → Define Entitlements → Assign Access → Configure Governance

The goal is no manual SQL, no Neon access and no operator script for a normal onboarding. The proposal must include:
- the first-admin threat model (domain proof, invitation, optional approval);
- reuse of the Security Journal for every onboarding step;
- no weakening of RLS, default deny or "no implicit first owner".

## Allowed

Review, documentation, non-mutating verification, scope proposals.

## Forbidden

- Implementation before the scope is approved.
- Production grants or business-data mutation.
- Merge, deploy, env or migration changes without explicit human approval.
- Any change to PR12.

## Stop condition

STOP after the proposal, and wait for approval before any code.
