# FIRST ADMIN / BREAK-GLASS V1, MIGRATION `Organization.status` + `Session.scope`: PRODUCTION RELEASE PASS

Date: 2026-10-11 (UTC).
- Design, approved by the operator: `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-MIGRATION-DESIGN.md` (M1 to M6, A1 to A5).
- Operations and rollback: `docs/operations/ORGANIZATION-STATUS-SESSION-SCOPE-MIGRATION.md`, `docs/operations/ORGANIZATION-STATUS-SESSION-SCOPE-ROLLBACK.sql`.

The operator approved each gate in chat, separately:
- the design (PR #40);
- the merge of the code PR pinned on its exact SHA, together with the Production migration;
- the human sign-in check.

Production reads were made in `READ ONLY` transactions (owner, or `app_user` for resolution). No application version was deployed.

## Releases

| Step | Reference | Result |
|---|---|---|
| Design | PR #40 → `953223a` | CI PASS on the head (`581a378`) and on `main` (run 38155641732) |
| Code, first head | PR #41 `dd8c99b` | CI FAIL: test bugs only (see T1), no product defect |
| Code, fixed head | PR #41 **`3336515`** | CI PASS (run 38157395248). The status suite passes 14 of 14 on PostgreSQL, including the migration drill and five real races. |
| Merge | pinned on `3336515` → **`4e98edf`** | CI PASS on `main` (run 38158644777) |
| Production migration | `20261011180000_organization_status_session_scope` | `prisma migrate deploy`, owner, direct endpoint, **17:16:44Z → 17:16:57Z** |
| Application | **`dpl_2QzBdDXtXAGSL49SYXoGd1vRbCrD` @ `ebb4f46`** | Unchanged. The migration is expand-only. |

## Clone rehearsal (before any Production action)

Two isolated Neon clones of Production were used and deleted after the rehearsal. The archive branch `br-icy-darkness-aho1v83p` was kept for B4.

| Check | Result |
|---|---|
| Business digest of the 48 tables, before and after | identical |
| Backfill | both organizations ACTIVE, `statusChangedAt` NULL; 109 sessions FULL |
| Existing sessions | Legrand's open session resolves through both resolvers |
| Grants | the migration itself grants `app_user` the two runtime functions |
| Behavior | **21 of 21** (details below) |
| Lab closed **on the clone only** | nothing left to neutralize (0 open sessions, 0 open invitations, 0 held domains); CLOSED is final, status and name. In Production, closing the Lab (B4) will therefore only change its status. |
| Rollback (`prisma db execute`) | digest **and every function and trigger definition identical** to before; back to 20 migrations; `resolve_session` keeps its grant |
| Re-apply after rollback | digest identical; definitions identical to the first apply |
| Rollback once a status is in use | refused (`ROLLBACK_REFUSED_ORGANIZATION_STATUS_IN_USE`), nothing written |

The 21 behavior checks covered:
- A1: a transition without the governance lock is refused;
- M3: `app_user` cannot change the status;
- M1: a transition without its effects is refused, explicitly and at COMMIT;
- SUSPENDED revokes the sessions and resolves nothing, through the canonical resolver and the wrapper;
- no sign-in is possible for SUSPENDED;
- A3 and A4: sessions are append-only;
- a RECOVERY session never comes back through the wrapper;
- a real race: the transition waits for the sign-in, then revokes it.

## Production

| Check | Before (17:16:27Z) | After (17:17:21Z) |
|---|---|---|
| Backup branch | `br-twilight-wildflower-ah68mp0p` (`backup-pre-status-scope-20261011`), 17:16:00Z, LSN `0/3D9D6E0`, no compute, expires 2026-10-25 | |
| Migrations applied | 20, none failed | **21**, none failed |
| Business digest, 48 tables | `971847c9…` | **identical** |
| Organizations | `legrand-tech`, `luxia-certification-lab` | **both ACTIVE**, `statusChangedAt` NULL |
| Sessions | 109 (11 not revoked) | 109 (11 not revoked), **all FULL** |
| Legrand's open session through `resolve_session` (`app_user`) | resolves | **resolves** |
| Function and trigger definitions | `4d43cfc4…` | `4ab441c5…`, **identical to the rehearsed clone** |

**Grants (`app_user`):**
- it executes `resolve_session`, `luxia_session_resolve`, `luxia_organization_lock_active` and `luxia_invitation_resolve`;
- it cannot execute the three guard functions;
- no function has a PUBLIC grant;
- `app_user` stays NOSUPERUSER and NOBYPASSRLS.

**Triggers:** the five triggers are enabled, and `organization_status_effects` is DEFERRABLE INITIALLY DEFERRED.

**Application:** `/login` returns 200 and `/api/onboarding/checklist` returns 401 without a session. The deployment is unchanged.

## Human check after the migration

The operator signed out of Legrand Tech at 17:21:28Z, then signed in with Microsoft Entra ID at 17:21:38Z.
- **The new session is FULL**, active, lasts 24 h, belongs to an ACTIVE organization, and resolves through both resolvers (database read).
- The sign-out revoked the previous session normally. A revocation from NULL to a timestamp is allowed by the append-only rule.
- In the browser (reads only, organization checked first):
  - the header shows "Legrand Tech, environnement Production";
  - the overview and the checklist line « Avoir un second administrateur permanent, qui peut se connecter » are shown;
  - the journal lists the sign-in and the sign-out;
  - the Authentication page lists the current session and 7 active passkeys.

## Findings

- **T1, test bugs only, fixed before merge.**
  - In `pg_locks`, a row wait is a `transactionid` lock with no database (or a `tuple` lock). The wait detector filtered these out, so the race tests waited forever and exhausted the pool.
  - Gates are now always reopened, even when a test fails.
- **P1, Prisma behavior, binding for B4.** Verified on a temporary Neon clone, which was deleted. When the deferred completeness check fails at COMMIT, PostgreSQL refuses the commit and writes nothing, but **Prisma 5.20 resolves the interactive transaction**.
  - B4 must end every transition with `SET CONSTRAINTS ALL IMMEDIATE` and re-read the state after the commit.
  - This is recorded in the design (4.2) and in the operations notes. The database guarantee does not depend on it.

**FIRST ADMIN / BREAK-GLASS V1, MIGRATION `Organization.status` + `Session.scope`: PRODUCTION RELEASE PASS**

## Next

B3, Organization Lifecycle Enforcement, in a separate code PR (scope approved by the operator on 2026-10-11). Then B2, B4 and B5.
