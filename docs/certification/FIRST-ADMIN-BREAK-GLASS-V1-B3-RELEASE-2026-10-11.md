# FIRST ADMIN / BREAK-GLASS V1, B3 ORGANIZATION LIFECYCLE ENFORCEMENT: PRODUCTION RELEASE PASS

Date: 2026-10-11 (UTC).
- Scope approved by the operator on 2026-10-11.
- Design: `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1.md` (B3 section) and `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-MIGRATION-DESIGN.md` (sections 5 and 7).
- Rollback of the B3 migration: `docs/operations/B3-SESSION-RESOLVE-ROLLBACK.sql`.

The operator approved each gate in chat, separately:
- the merges pinned on exact SHAs;
- the clone rehearsal;
- the Production migration;
- the deployment;
- the human sign-in check.

Production database reads were made in `READ ONLY` transactions (owner, or `app_user` for resolution). Browser checks were reads only, after the session's organization was confirmed.

## What B3 changes

- **Before authentication:** SUSPENDED and CLOSED are indistinguishable from an unknown organization, at passkey and Microsoft sign-in, at the Microsoft callback and for invitations. Every answer is the generic one.
- **Session resolution:** only the canonical resolver `luxia_session_resolve`. It now also refuses a non-ACTIVE subject or identity account. FULL sessions only, until B2.
- **Conditional writes:** the `lastSeenAt` refresh, sign-out (recorded once) and administrator session revocation never fail on a concurrent revocation.
- **Lock order:** governance lock, then the organization row, then the first write. An architecture test enforces it.
- **Operator-only transition primitive:**
  - suspension revokes every active session in the same transaction;
  - reactivation brings nothing back;
  - closing is irreversible.

  B4 will wrap it.

## Releases

| Step | Reference | Result |
|---|---|---|
| Migration release evidence | PR #42, pinned on `af92410` → **`1086a85`** | CI PASS on the head (run 38159922086), docs only |
| B3, first head | PR #43 `b43f826` | CI FAIL on one older race test, which expected the raw `ORGANIZATION_NOT_ACTIVE`. B3 deliberately answers `INVITATION_INVALID`, like an unknown token, and the assertion was aligned. |
| B3, final head | PR #43 **`6bdeea2`** | CI PASS (run 38170929999): lifecycle 7/7, status and scope 14/14, last administrator 11/11, Microsoft callback 6/6 (organization suspended during the round trip), B3 architecture 6/6, 34 security files, build |
| Merge | pinned on `6bdeea2` → **`8aec711`** | CI PASS on `main` (run 38171480145) |
| Production migration | `20261011200000_session_resolve_subject_account` | `prisma migrate deploy`, code `main` `8aec711`, owner, direct endpoint, **20:28:54Z → 20:29:04Z** |
| Production deployment | **`dpl_8YEyT71Z1o3CUfb8qSCTZ9V1dr6o` @ `8aec711`** | Created 20:34:50Z, READY 20:36:18Z, production target. Built by Vercel from GitHub at the exact SHA. No env change. |
| Rollback deployment | `dpl_2QzBdDXtXAGSL49SYXoGd1vRbCrD` @ `ebb4f46` | READY |

## Clone rehearsal

The rehearsal ran at about 20:20Z on a Neon clone of Production, with code `8aec711`. The clone was deleted afterwards.

| Check | Result |
|---|---|
| Business digest of the 48 tables, before and after | identical |
| What changed | **only** `luxia_session_resolve`; `resolve_session` identical; grants kept |
| Legrand's open session | resolves through both resolvers, before and after |
| Migrations | 21 → 22 |
| Subject not ACTIVE (SUSPENDED, DISABLED, RECOVERY_REQUIRED, RETIRED, PROVISIONING) | refused by both resolvers; resolves again once ACTIVE |
| Identity account DISABLED | refused by both resolvers; resolves again once ACTIVE |
| Rollback (`prisma db execute`) | **exact**: digest and every function definition identical to before; back to 21 migrations |
| Re-apply | digest and definitions identical to the first apply |

The behavior checks ran on an organization created on the clone. Legrand was only read.

## Production migration

| Check | Before (20:28:38Z) | After |
|---|---|---|
| Backup branch | `br-cold-bread-ah1hlohl` (`backup-pre-b3-session-resolve-20261011`), 20:26:37Z, LSN `0/3E37AA0`, no compute, expires 2026-10-25 | |
| Migrations | 21, none failed | **22**, none failed |
| Changed functions | | **`luxia_session_resolve` only**, identical to the rehearsed definition; the wrapper and triggers are unchanged |
| Canonical resolver checks the subject and the account | no | **yes** |
| Legrand's open session, through `resolve_session` and `luxia_session_resolve` (`app_user`) | resolves | **resolves** |
| `app_user` grants | runtime functions only | **unchanged**: no PUBLIC grant; NOSUPERUSER, NOBYPASSRLS |
| Organizations | both ACTIVE | both ACTIVE |

**First reading, retaken.** The first pre-migration reading (20:27:19Z) fell between the operator's sign-out (20:27:14Z) and new sign-in (20:27:26Z), so it showed no open session. It was retaken at 20:28:38Z with the new session.

**Gap in `CanonicalAdminAuditEvent`, explained.** The business digest is identical for every table except the canonical journal. The operator was using the application during the migration. Proof, read-only:
- the **376 rows that existed before are identical**: the pre-migration digest was rebuilt exactly from them (cut-off 20:27:41.648Z);
- the **6 new rows are appends from the operator's own Legrand activity**:
  - `SOD.POLICY.READ` and `SOD.CONFLICT.READ` at 20:28:46Z;
  - `AUDIT.READ` at 20:28:50Z;
  - `DASHBOARD.POSTURE.READ` at 20:29:02Z and `ONBOARDING.CHECKLIST.READ` at 20:29:03Z;
  - `SESSION.SIGN_OUT` at 20:29:11Z;
- the migration only replaces one function and writes no data;
- the dashboard and the sign-out kept working during and right after it.

## Deployment and checks

- **Without a session:**
  - `/login` 200;
  - `/api/onboarding/checklist` and `/api/me/sessions` 401 `{"error":"Unauthorized"}`;
  - `/dashboard` 307 → `/login`.
- **Operator sign-in after the deployment**, with a **passkey**, at 20:41:04Z. This exercises the whole new B3 path: organization resolution, organization lock, then session creation. Database read:
  - **new session FULL**, active, 24 h, organization ACTIVE;
  - it **resolves through `resolve_session` and `luxia_session_resolve`**;
  - **one VERIFIED sign-in evidence**.
- **Browser** (reads only; the header shows "Legrand Tech, environnement Production, Compte local LUXIA"):
  - the overview loads with its 8 sections, from Mise en route to Activité récente, and no alert;
  - the checklist API returns 200;
  - the journal lists the passkey sign-in;
  - the Authentication page lists the current session and 7 active passkeys.
- **No rollback was needed.** `dpl_2QzBdDXtXAGSL49SYXoGd1vRbCrD` stays available.

**FIRST ADMIN / BREAK-GLASS V1, B3 ORGANIZATION LIFECYCLE ENFORCEMENT: PRODUCTION RELEASE PASS**

## Next

B2, personal recovery codes and the recovery-only session. The design comes first and needs approval before any code.
