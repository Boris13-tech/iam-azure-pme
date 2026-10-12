# FIRST ADMIN / BREAK-GLASS V1, B1 LAST-ADMINISTRATOR GUARD: PRODUCTION RELEASE PASS

Date: 2026-10-11 (UTC). Scope: `docs/product/FIRST-ADMIN-BREAK-GLASS-V1-SCOPE.md` (PR #37, K1 "refuse"). Design and tests: `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1.md`.

The operator approved each gate in chat, separately: the B1 design, the merge pinned on an exact SHA, the Production deployment, and the rolled-back proof in Production. Database reads were read-only (`SET TRANSACTION READ ONLY`, owner role) unless stated. Browser checks were reads only, after the session's organization was confirmed (lesson from I1).

## What B1 changes

No change, alone or concurrent, may take a tenant from at least one **durable administrator** to none. Such a change is refused with `LAST_ADMINISTRATOR_PROTECTED` (409), audited as `<OPERATION>.DENIED`, and leaves nothing behind.

A durable administrator must:
- be an ACTIVE human;
- have an ACTIVE identity account of their own;
- hold a native `assignments.manage` grant that is effective and has no end date.

The operator approved this definition. A tenant already at zero is not frozen.

The guard reuses the tenant governance lock, which the SoD trigger already takes, before any row lock. The overview item now reads « Avoir un second administrateur permanent, qui peut se connecter ».

## Releases

| Step | Reference | Result |
|---|---|---|
| Scope | PR #37 → `84a9249` | CI PASS on `main` (run 38149582786), docs only, not deployed |
| First revision | PR #38 head `0a137ed` | CI PASS (run 38151073810, 8 B1 PostgreSQL tests). **Not merged:** the operator's review checklist led to finding a deadlock risk (finding B1-R1 below). |
| Review fix | PR #38 head **`2d61ee6`** | CI PASS (run 38152250883): 11 B1 PostgreSQL tests and 6 architecture tests, no deadlock |
| Merge | pinned on `2d61ee6` → **`ebb4f46`** | CI PASS on `main` (run 38152569766) |
| Production deployment | **`dpl_2QzBdDXtXAGSL49SYXoGd1vRbCrD` @ `ebb4f46`** | Created 15:53:00Z, READY 15:54:37Z, production target, alias assigned. Built by Vercel from GitHub at the exact SHA. No migration, no env change. |
| Rollback deployment | `dpl_Ao1hwzYREFMHVMqZotEHkQ67QAyJ` @ `5e8c887` | READY |

## Finding B1-R1 (fixed before merge)

**Observed:** the first revision guarded removals with its own advisory lock. The SoD trigger takes the tenant governance lock on every Assignment write. So:
- a catalog grant revocation took the guard lock, then the governance lock;
- the governance writers took them in the opposite order.

Two concurrent requests could therefore deadlock. PostgreSQL would have aborted one of them with a 500 error, without corrupting data.

The same review found a pre-existing ordering issue. ADMIN invitation acceptance locked the invitation and person rows before the trigger's lock, which could deadlock with an invitation revoke.

**Fix (`2d61ee6`):**
- one lock, the governance lock;
- taken before any row lock, in every transaction that can write grants: canonical operations, invitation acceptance and legacy dual write.

The architecture test now checks the lock key against the trigger and checks the lock order. Two mixed concurrency scenarios, each run in two orders, fail on any error other than the expected business refusals.

## No migration

- B1 does not touch `prisma/`, `vercel.json` or the workflows (git diff `84a9249..ebb4f46`).
- **Production has all 20 repository migrations applied**, with none pending, none failed or rolled back, and none unknown. The last one is `20261011000000_customer_self_onboarding_v1`, finished 2026-10-11T01:25:23Z. Checked before deployment and again after the proof.

## Durable administrators in Production (counts only)

| Organization | Grant holders of `assignments.manage` | Durable administrators | Temporary grants |
|---|---|---|---|
| `legrand-tech` | 1 | **1** | 0 |
| `luxia-certification-lab` | 1 | **0** (neutralized: accounts disabled) | 0 |

The same counts were read before deployment and after the proof. With these counts:
- in Legrand Tech, nobody can remove the only administrator;
- the Lab is not frozen by B1;
- nothing else changes for either organization.

## Rolled-back proof in Production (method of proof 7, approved)

`.tmp-probe/rehearsal/prod-b1-proof.ts` (operator workstation) ran with the merged code, between deployment READY and the operator's sign-in. It used `app_user` on the direct Production endpoint, under Legrand Tech's RLS context, in **one transaction that is always rolled back**. It called the library guard directly, because the canonical API would commit a DENIED event to Legrand's append-only journal.

| Check | Result |
|---|---|
| Role | `app_user`, BYPASSRLS false |
| Durable administrators inside the transaction | 1 |
| Revoking that administrator's `assignments.manage` through the guard | **refused: `LAST_ADMINISTRATOR_PROTECTED`** |
| Grant inside the transaction after the refusal (savepoint rollback) | ACTIVE |
| Transaction | rolled back by design |
| Before / after: grant (status, no end date, `updatedAt` 2026-10-02T07:57:09.565Z), durable count, journal events | **strictly identical** (1 / 1, 272 / 272) |

After the UI checks, Legrand's journal holds **0** events with `LAST_ADMINISTRATOR_PROTECTED`. The proof left nothing.

## Live checks

- Unauthenticated: `/login` 200; `/api/onboarding/checklist` 401.
- **Operator sign-in to Legrand Tech:** Microsoft Entra ID at 15:58:48Z. The session header showed "Legrand Tech, environnement Production".
- **Overview:** loads normally, "À traiter" shows nothing.
- **Mise en route:** the new label is shown and stays to do. The API returns `secondAdministrator: false`, which is correct with one durable administrator.
- **Audit journal:** the 15:58:48Z sign-in is listed, attested by Microsoft. There is no denial.
- **Authentication:** the current session is listed, with 7 active passkeys, unchanged.
- **Organisation:** no domain and no invitation, as before.

**FIRST ADMIN / BREAK-GLASS V1, B1 LAST-ADMINISTRATOR GUARD: PRODUCTION RELEASE PASS**

## Next

The operator approved this order for the rest of the phase:
1. Migration `Organization.status` and `Session.scope`. Its design must be approved before any code.
2. B3.
3. B2.
4. B4, with the Lab replay from the archive branch `br-icy-darkness-aho1v83p`. That branch is kept until B4 is certified, then deleted.
5. B5.
