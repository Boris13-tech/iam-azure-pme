# FIRST ADMIN / BREAK-GLASS V1, B5 VISIBILITY FOR THE CUSTOMER: PRODUCTION RELEASE PASS

Date: 2026-10-12 (UTC).
- Scope: approved in section 3 of `docs/product/FIRST-ADMIN-BREAK-GLASS-V1-SCOPE.md`. Implementation notes: `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1.md` (B5 section).
- Released under the low-risk Production rule confirmed by the operator on 2026-10-12. The release qualified because:
  - there is no migration and no data change;
  - no authorization is weakened;
  - the exact rollback deployment was ready;
  - the full CI passed.

## What B5 changes

- **Journal:**
  - the 7 LUXIA operator actions read « Action opérateur LUXIA : … »;
  - the 4 B2 operations have French labels;
  - a test fails if any journaled operation has no label.
- **Recovery-code sign-ins:** shown as « Code de récupération » with their real, low assurance. They are recognised by the assurance profile `local-recovery`.
- **« Mes sessions »:** a RECOVERY session is shown as such.
- **Checklist:**
  - new fact `recoveryCodes` (true, false, or not shown when it does not apply);
  - the overview asks for the checklist only when the viewer holds its right.

## Releases

| Step | Reference | Result |
|---|---|---|
| Code | PR #52 `53499e0` → **`ec9ee2e`** | CI PASS (run 38303089079). B5 static 4/4; PostgreSQL suites: recovery 18/18, posture 10/10, domains and invitations 6/6, B4 9/9, B1 11/11 |
| Merge tree | `ec9ee2e` | Identical to the CI-tested head |
| Deployment | **`dpl_9DAyHFHgKa15csWqna97ZueymNxR` @ `ec9ee2e`** | Created 20:24:52Z, READY 20:25:55Z, production target. Built by Vercel from GitHub at the exact SHA |
| Rollback | `dpl_3Jm2usCcwnM4JZndgAU9A7ngkfnT` @ `2414ec6` (B4) | READY |

## Checks

**Before the deployment:**
- the global and per-organization snapshots were taken read-only;
- 24 migrations, none failed;
- Legrand Tech ACTIVE; the Lab and `luxia-cert-b2-r6` CLOSED.

**After the deployment, without a session:**
- the B2 smoke suite passed 20/20;
- posture, checklist, own sessions and security journal APIs answer 401;
- `/dashboard/audit` and `/dashboard/settings` redirect to `/login`.

**Production facts, read-only, with the shipped rules:**

| Check | Result |
|---|---|
| Journal | 44 distinct operations in Production, **0 without a label** (8 before B5). The 4 operator action types present read « Action opérateur LUXIA : … » |
| Sign-in evidence | The 3 recovery-code sign-ins (2 verified, 1 refused) are now shown as `RECOVERY_CODE`; passkey and Microsoft sign-ins are unchanged |
| Checklist `recoveryCodes` | Legrand Tech: **false** (1 durable administrator with a local passkey account, 0 usable codes). The Lab: not applicable |
| Who may read the checklist | Legrand Tech: its 1 active person holds `subjects.read` |
| « Mes sessions » | No open session of any scope at the time of the check; the RECOVERY label is covered by the PostgreSQL suite |

**Invariants, before and after (identical):**
- business digest of every table;
- functions and triggers;
- the rights of `app_user` and on tables;
- organizations and the 24 migrations;
- the rows of Legrand Tech, the Lab and `luxia-cert-b2-r6`, compared row by row for the journal and the sign-in evidence.

**Not observed in Production:**
- **Members, partial viewers and an open recovery session:** Legrand Tech has a single person, and no recovery session was open. These cases are covered by the PostgreSQL suites (full, partial and no-rights viewers; a real recovery sign-in).
- **The served dashboard code:** a probe without a session can read only the login page's client files. The code served is proven by the deployment's exact commit.

**No rollback was needed.**

**FIRST ADMIN / BREAK-GLASS V1, B5 VISIBILITY FOR THE CUSTOMER: PRODUCTION RELEASE PASS**

With B5, **First Admin / Break-glass v1 is complete**: B1, the status migration, B3, B2, B4 and B5 all passed in Production.
