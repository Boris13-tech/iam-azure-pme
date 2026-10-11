# LUXIA Identity — NEXT TASK

Read `docs/handoff/CURRENT-STATE.md` first.

## Completed

- 2026-10-10: Resource Access Onboarding v1 (Production E2E PASS), Dashboard v1 (PASS), Security Journal v1 (PASS).
- 2026-10-11: **Customer Self-Onboarding v1: PRODUCTION CERTIFICATION PASS.**
  - Release: `docs/certification/CUSTOMER-SELF-ONBOARDING-V1-RELEASE-2026-10-11.md`.
  - Multi-organization certification (10 proofs, F1 fixed, D1, I1, Lab neutralized): `docs/certification/CUSTOMER-SELF-ONBOARDING-V1-MULTI-ORG-CERTIFICATION-2026-10-11.md`.

## Next objective (operator roadmap): First Admin / Break-glass

Write a **scope proposal** (docs only, approval before code). The certification showed why this is needed: the last account of an organization cannot be disabled through the product, and the Lab had to be neutralized by a provisional operator action outside the product. The proposal should cover:
- an audited, operator-approved break-glass procedure;
- recovery of the first administrator;
- no implicit authority.

## Small follow-ups (each needs its own approval)

- **Unused function:** drop `luxia_login_decoy` (migration).
- **Journal labels:** add French labels for `BREAK_GLASS.*`.
- **Checklist visibility:** show the onboarding checklist only to administrators, to avoid `ONBOARDING.CHECKLIST.READ.DENIED` noise for members.

## Then (operator roadmap)

Access Requests → Observability → Backup/Restore → Provider certification (PR12) → Docs/API → Billing/Legal → Private Beta → GA.

## Forbidden

- Production grants or business-data mutation outside an approved ceremony.
- Merge, deploy, env or migration changes without explicit human approval.
- Any change to PR12.
