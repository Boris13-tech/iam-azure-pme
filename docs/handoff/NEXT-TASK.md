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

- 2026-10-12: **B5 visibility for the customer: PRODUCTION RELEASE PASS** (`docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-B5-RELEASE-2026-10-12.md`). **First Admin / Break-glass v1 is complete.**

First Admin / Break-glass v1 status: **B1, migration, B3, B2, B4, B5: all PASS in Production.**

## Priorities (operator order of 2026-10-12, refined with the post-B5 evidence)

1. **P1, audit integrity first (T0):** make the journal and the sign-in evidence append-only. That means a guard on UPDATE and DELETE, and the grants revoked from `app_user`. It is small and protective, and it is the prerequisite of every transparency and Trust Ledger promise. See `docs/architecture/LUXIA-OPERATOR-TRANSPARENCY.md`.
2. **P1, backup and restore:** follow `docs/operations/BACKUP-RESTORE-PLAN.md`. Drill A runs when a branch slot frees on 2026-10-15. Drill B and the independent backups wait for the operator to decide where data may be copied.
3. **P1, minimum observability:** error tracking, a health route, an external uptime check and an alert. Tools are chosen as adapters, without lock-in.
4. **P2, time convention phases 1 and 2** (no migration): `docs/architecture/LUXIA-TIME-CONVENTION.md`.
5. **P2, product trust:** « Interventions de LUXIA » (T1), then Trust Ledger v0 (T2), after T0.

Operator decisions pending:
- hosting plans and regions (E3);
- privacy and legal basis (E5);
- where independent backups may live.

See `docs/product/ENTERPRISE-READINESS.md`.

## Small follow-ups

- **Unused function:** drop `luxia_login_decoy`. It is a migration with a DROP, so it needs operator approval.
- **Authentication navigation:** the « Authentification » link needs `providers.read`, so members reach their recovery codes only through the R5 notice or the URL.
- **B4 rows written with the workstation clock** (`REVOKE_SESSIONS`, `DISABLE_ACCOUNT`): phase 1 of the time convention.

## Then

1. **PR #12 Providers Management** (very stale), only after the P1 items, unless a customer depends on it.
2. Support and escalation, billing and licensing, customer and API documentation, a demo environment.
3. Private Beta, then GA.

## Rules

- Low-risk Production changes follow the rule the operator confirmed on 2026-10-12. Conditions: reversible, full CI PASS, known rollback, no data or secret touched, no protection lowered, no trust model changed. Flow: analysis, decision, merge, deployment, verification, rollback if needed, report.
- Operator approval stays required for:
  - deletion;
  - destructive or hard-to-reverse migrations;
  - changes to the IAM, Trust or Policy model;
  - lowering a protection;
  - secrets and trust roots;
  - new data exposure;
  - major product decisions;
  - spending.
- Any change to PR #12 needs approval.
