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

1. **Done, PRODUCTION VERIFIED 2026-10-13: T0 audit integrity.** The journal and the sign-in evidence are append-only for application and ordinary operator roles (`docs/certification/T0-AUDIT-APPEND-ONLY-RELEASE-2026-10-13.md`). It is not cryptographic immutability, which belongs to Trust Ledger.
2. **Done, PRODUCTION PASS 2026-10-13: E1 backup and restore** (`docs/certification/E1-BACKUP-RESTORE-DRILL-B-2026-10-13.md`):
   - an encrypted backup every 6 hours in EU object storage;
   - Drill B identical, RPO 2 min 7 s, 81 s.

   Still to do:
   - **operator:** key custody, and the immutability lock;
   - **Claude:** rehearse the switch of the application; Drill A when a branch slot frees on 2026-10-15; a backup freshness alert in the Ops block.
3. **P1, minimum observability:** HTTP availability, server errors, latency, database availability, abnormal authentication failures, backup failures, quota saturation, critical security events, and an alert channel.
4. **P1 before a commercial beta:**
   - EU hosting (Frankfurt by default), as a rehearsed platform migration;
   - the legal drafts (`DRAFT — LEGAL REVIEW REQUIRED`).
5. **P2:**
   - time convention phases 1 and 2;
   - the provider-neutral notification contract (`Notification → Channel Adapter`);
   - « Interventions de LUXIA » (T1), then Trust Ledger v0 (T2).

Operator decisions of 2026-10-13 and the readiness gate (`UNKNOWN`, `DESIGNED`, `IMPLEMENTED`, `VERIFIED`, `PRODUCTION VERIFIED`): `docs/product/ENTERPRISE-READINESS.md`.

## Small follow-ups

- **Unused function:** drop `luxia_login_decoy`. It is a migration with a DROP, so it needs operator approval.
- **Authentication navigation:** the « Authentification » link needs `providers.read`, so members reach their recovery codes only through the R5 notice or the URL.
- **B4 rows written with the workstation clock** (`REVOKE_SESSIONS`, `DISABLE_ACCOUNT`): phase 1 of the time convention.

## Then (commercial order, operator decision of 2026-10-13)

**E1 Backup/Restore (done) → PR #12 Sovereign Providers → Ops/Monitoring → Legal final review → pilot offer → 3 to 5 customers → Billing, SLA, pentest → GA.**

1. **PR #12, rewritten as the LUXIA Sovereign Provider & Federation Layer.** It is never merged as it stands.
   - **Principles:**
     - LUXIA is the authority; a provider only proves an identity;
     - provider-neutral core, with a generic OIDC contract first; Entra and Google are adapters;
     - LUXIA_LOCAL stays first-class;
     - no permission is imported implicitly;
     - tenant-scoped connections;
     - secrets by reference only;
     - every provider action is journaled;
     - fail closed;
     - disabling a provider never removes a Subject;
     - no regression of B1 to B5, T0 or RLS.
   - **Steps:**
     1. compare the 46 old files with `main`;
     2. classify each as reusable, to rewrite, or obsolete;
     3. **design document before any code**;
     4. certification plan for Entra, generic OIDC and LUXIA_LOCAL;
     5. no merge and no Production before a rehearsal and approval.
2. Ops/Monitoring.
3. Support and escalation, billing and licensing, customer and API documentation, a demo environment.
4. Private beta, then GA.

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
- PR #12: the old branch is never merged as it stands. Its rewrite starts with a design document, and needs approval before any merge or Production step.
