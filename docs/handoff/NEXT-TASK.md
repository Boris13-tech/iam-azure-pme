# LUXIA Identity — NEXT TASK

Read `docs/handoff/CURRENT-STATE.md` first.

## Completed

- 2026-10-10: Resource Access Onboarding v1 (Production E2E PASS), Dashboard v1 (PASS), Security Journal v1 (PASS).
- 2026-10-11: **Customer Self-Onboarding v1: PRODUCTION CERTIFICATION PASS.**
  - Release: `docs/certification/CUSTOMER-SELF-ONBOARDING-V1-RELEASE-2026-10-11.md`.
  - Multi-organization certification (10 proofs, F1 fixed, D1, I1, Lab neutralized): `docs/certification/CUSTOMER-SELF-ONBOARDING-V1-MULTI-ORG-CERTIFICATION-2026-10-11.md`.
- 2026-10-11: **First Admin / Break-glass v1: scope approved** (PR #37, `docs/product/FIRST-ADMIN-BREAK-GLASS-V1-SCOPE.md`, K1 to K5 and section 9).
- 2026-10-11: **B1 last-administrator guard: PRODUCTION RELEASE PASS** (`docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-B1-RELEASE-2026-10-11.md`, design in `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1.md`).
- 2026-10-11: **Migration `Organization.status` + `Session.scope`: PRODUCTION RELEASE PASS** (`docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-MIGRATION-RELEASE-2026-10-11.md`, design in `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-MIGRATION-DESIGN.md`).
- 2026-10-11: **B3 organization lifecycle enforcement: PRODUCTION RELEASE PASS** (`docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-B3-RELEASE-2026-10-11.md`, notes in `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1.md`).
- 2026-10-12: **B2 recovery codes and recovery-only session: PRODUCTION RELEASE PASS** (`docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-B2-RELEASE-2026-10-12.md`, design in `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-B2-RECOVERY-DESIGN.md`). R6 ran on the test organization `luxia-cert-b2-r6`, later CLOSED by B4.
- 2026-10-12: **B4 operator break-glass procedure: PRODUCTION RELEASE PASS** (`docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-B4-RELEASE-2026-10-12.md`, design in `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-B4-OPERATOR-DESIGN.md`). The Lab and `luxia-cert-b2-r6` are CLOSED through the procedure; the journal-time fix (PR #50) is merged.

First Admin / Break-glass v1 status: **B1 PASS → migration PASS → B3 PASS → B2 PASS → B4 PASS → next = B5**.

## Next objective: First Admin / Break-glass v1, in the order approved by the operator

1. **B5, next, design first**: visibility and posture:
   - durable second administrator;
   - recovery codes created;
   - French labels for operator actions and for `RECOVERY.*` and `RECOVERY_CODES.*`;
   - a recovery session shown as such (not « Clé d'accès ») in « Mes sessions ».

## Small follow-ups (each needs its own approval)

- **Unused function:** drop `luxia_login_decoy` (migration).
- **Journal labels:** add French labels for `BREAK_GLASS.*` (part of B5).
- **Checklist visibility:** show the onboarding checklist only to administrators, to avoid `ONBOARDING.CHECKLIST.READ.DENIED` noise for members.
- **Authentication navigation:** the « Authentification » link needs `providers.read`, so members reach their recovery codes only through the R5 notice or the URL. A small separate UX PR if needed (operator decision, 2026-10-12).

## Then (operator roadmap)

1. **PR #12 Providers Management.** It is very stale: realign it on `main`, resolve the conflicts, check that it works with multi-organization and self-onboarding, then certify real providers again.
2. Enterprise topics:
   - observability;
   - backup and restore with RTO/RPO;
   - support and escalation;
   - billing and licensing;
   - privacy, DPA and GDPR;
   - security incident response;
   - customer and API documentation;
   - a demo environment.
3. Private Beta, then GA.

## Forbidden

- Production grants or business-data mutation outside an approved ceremony.
- Merge, deploy, env or migration changes without explicit human approval.
- Any change to PR12 without approval.
