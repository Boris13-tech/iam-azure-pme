# LUXIA Identity — NEXT TASK

Read `docs/handoff/CURRENT-STATE.md` first.

## Completed

- 2026-10-10: Resource Access Onboarding v1 (Production E2E PASS), Dashboard v1 (PASS), Security Journal v1 (PASS).
- 2026-10-11: **Customer Self-Onboarding v1 released.** PR #32 merged as `6f9de76`, Production migration applied (business digest identical, `legrand-tech`), deployed `dpl_7ZzzEA3DbQdAACKZP4f9V947gkad`. Legrand Tech validated live: Microsoft and passkey sign-in, dashboard, journal, sessions, passkeys, Organisation page. Evidence: `docs/certification/CUSTOMER-SELF-ONBOARDING-V1-RELEASE-2026-10-11.md`.

## Next: second organization and cross-tenant certification (separate operator approval required)

1. The operator issues a beta code with `scripts/operators/signup-codes.ts issue`, using the Production owner connection. The code is shown once.
2. A real second organization is created on `/signup`: founder passkey, then sign-in with its own identifier.
3. Domain TXT verification, then an invitation (member and administrator) accepted by a second person.
4. The ten proofs of `docs/architecture/CUSTOMER-SELF-ONBOARDING-V1.md` (Production certification plan), each cross-checked read-only in the database, with Legrand Tech re-checked.

## Then (operator roadmap)

First Admin / Break-glass → Access Requests → Observability → Backup/Restore → Provider certification (PR12) → Docs/API → Billing/Legal → Private Beta → GA.

## Forbidden

- Creating the second organization, or any Production grant or business-data mutation, without the explicit approval of that step.
- Merge, deploy, env or migration changes without explicit human approval.
- Any change to PR12.
