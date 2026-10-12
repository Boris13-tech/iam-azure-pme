# FIRST ADMIN / BREAK-GLASS V1, B2 RECOVERY CODES AND RECOVERY-ONLY SESSION: PRODUCTION RELEASE PASS

Date: 2026-10-11 to 2026-10-12 (UTC).
- Design approved by the operator on 2026-10-11 (decisions R1 to R6): `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-B2-RECOVERY-DESIGN.md` (PR #45).
- Implementation notes: `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1.md` (B2 section).
- Rollback of the B2 migration: `docs/operations/B2-RECOVERY-CODES-ROLLBACK.sql`.

The operator approved each gate in chat, separately:
- the merge pinned on an exact SHA;
- the clone rehearsal;
- the Production migration;
- the deployment;
- the signup code for the test organization;
- the neutralization of that organization.

Those approvals arrived as pasted text, so the operator confirmed each one again directly, in a structured question, before the step ran.

**How Production was read:**
- database reads ran in `READ ONLY` transactions, as the owner, or as `app_user` for session resolution;
- the outputs are counts, statuses, operation names and hashes, with no session id, no code value and no key material;
- the value of the signup code was shown once to the operator and appears nowhere else;
- the recovery codes were seen only by the operator.

## What B2 changes

- **Personal recovery codes:**
  - 10 per batch, 20 Crockford base32 characters (100 bits), shown once;
  - stored only as `SHA-256("luxia-recovery-code:v1:" + identityAccountId + ":" + code)`;
  - single use, no expiry (R1);
  - a new batch, or "revoke all", revokes the unused codes.
- **Generation:**
  - FULL session on the person's own LUXIA local account;
  - a passkey sign-in less than 15 minutes old (R2);
  - 5 batches per day.
- **Recovery sign-in** (`POST /api/auth/local/recovery`):
  - one generic 401 for every refusal, with a 400 ms floor;
  - limits of 10 per hour per client and 5 per hour per identifier, with no lockout (R3);
  - success opens a RECOVERY session of exactly 15 minutes.
- **Recovery-only session:**
  - refused by every page and API (FULL-only resolution), even for an administrator;
  - read only by the passkey enrolment of its own account and by the `/recovery` page;
  - signing out works for any scope.
- **Enrolment** (R4), in one transaction:
  - the recovery session ends;
  - the previous passkeys and security keys are revoked;
  - every other session of the account is revoked.

  TOTP is not touched: it is not used as a sign-in authenticator in the product.
- **R5:** the remaining codes stay valid after a recovery. A notice that cannot be dismissed asks for a new batch until one exists.
- **Database guard `luxia_recovery_code_guard`:**
  - at most 10 usable codes per account;
  - single use;
  - frozen rows, no delete;
  - an ACTIVE organization to create or consume a code.

## Releases

| Step | Reference | Result |
|---|---|---|
| Design | PR #45 → `cbe3d6f` | CI PASS on `main` (run 38174831831) |
| B2, first head | PR #46 `5ce185b` | CI PASS (run 38177841042): recovery PostgreSQL suite 18/18 in 32.7 s, recovery architecture 7/7, recovery codes 5/5, local RLS, function privilege gate, build |
| B2, final head | PR #46 **`db9f740`** | Comment and documentation only: R4 covers passkeys and security keys, and TOTP is not a sign-in authenticator. CI PASS (run 38178737105) |
| Merge | pinned on `db9f740` → **`fe34cf7`**, 2026-10-11 22:35:21Z | CI PASS on `main` (run 38181021762), including the recovery PostgreSQL suite 18/18 |
| Production migration | `20261012090000_recovery_codes_b2` | `prisma migrate deploy`, code `fe34cf7`, owner, direct endpoint, **2026-10-12 07:03:35Z → 07:03:46Z** |
| Production deployment | **`dpl_CiB2VuvFtru15AxNJfa5NfDF8q2F` @ `fe34cf7`** | Created 07:13:43Z, READY 07:15:28Z, production target. Built by Vercel from GitHub at the exact SHA. No env change. |
| Rollback deployment | `dpl_8YEyT71Z1o3CUfb8qSCTZ9V1dr6o` @ `8aec711` | READY |

**Before the merge**, a local PGlite drill of the migration passed 40/40 checks:
- backfill of rows written before B2;
- every guard rule, including the 10-code limit inside one multi-row insert;
- the 15-minute CHECK;
- SUSPENDED behaviour;
- rollback and re-apply.

It found a real bug in the first draft of the rollback, fixed before the merge: the `NOT VALID` hash CHECK is checked again on every UPDATE, so the rollback must drop it before it marks older rows as used.

## Clone rehearsal

Neon clone `br-flat-fire-ahanlhh0`, taken from Production at 2026-10-11 22:39Z (LSN `0/3F0E128`), with code `fe34cf7`. It expired automatically at 2026-10-12 06:39Z.

| Check | Result |
|---|---|
| Before | 22 migrations, 0 recovery codes, 115 FULL sessions, Legrand's open session resolves, both organizations ACTIVE |
| Migration (9 s) | Business digest of the 48 tables identical. **Only** `luxia_recovery_code_guard` added: not executable by `app_user` or PUBLIC, and no other function or grant changed. 23 migrations |
| Rollback (`prisma db execute`) | **Exact**: digest, definitions, table, grants and sessions identical to before; 22 migrations |
| Re-apply | Identical to the first apply |
| Behaviour, real B2 code (`app_user`, real routes) | **20/20**: the 18 B2 scenarios and the function privilege gate on the real Production ACLs |
| Isolation | The rows of Legrand Tech and the Lab are identical after the tests, in every table that has an organization. The tests created only their own 28 test organizations |
| Rollback with data | 129 revoked codes all marked used, so none came back. The 211 codes still usable stayed as they were. 8 open RECOVERY sessions were closed and the history row removed |
| Final re-apply | No earlier code usable; guard in place; Legrand and the Lab unchanged |

The 18 B2 scenarios covered:
- generation;
- revocation;
- single use;
- the RECOVERY session of 15 minutes;
- refusal by 14 normal routes, even for an administrator;
- enrolment with R4;
- the database guard;
- real races with lock waits.

Each scenario used a test identity created for it, with a software passkey.

**Two notes on how the rehearsal was run:**
- The first checkout used a stale local `origin/main` (`cbe3d6f`). It was noticed and corrected to `fe34cf7` before any test or migration ran on the clone; only the initial read, which does not depend on the code, came before.
- The clone is about 270 ms away per round trip. The suite ran from a temporary, uncommitted copy with timeouts multiplied by 10, checked identical otherwise, and then removed.

## Production migration

| Check | Before (07:02:30Z) | After |
|---|---|---|
| Backup branch | `br-dawn-scene-ahdunopo` (`backup-pre-b2-recovery-20261012`), 07:02:05Z, LSN `0/3F50090`, no compute, expires 2026-10-26 | |
| Migrations | 22, none failed | **23**, none failed |
| Business data (48 tables) | | **identical** |
| Functions and triggers | 19 functions, 14 triggers | **only** `luxia_recovery_code_guard` and its trigger `recovery_code_guard` added. The definition is identical to the rehearsal, runs with the caller's rights (`SECURITY INVOKER`) and pins `search_path` |
| `app_user` and PUBLIC | | **No extra right**: same executable functions (not the guard), no PUBLIC execute, table grants identical. `app_user` is still NOSUPERUSER and NOBYPASSRLS |
| `LocalRecoveryCode` | 0 rows | 0 rows; `batchId`, `revokedAt`, the hash CHECK (`NOT VALID`) and the index of usable codes added |
| Sessions and organizations | 115 FULL; both ACTIVE | unchanged |
| Legrand's open session (`resolve_session` and `luxia_session_resolve`) | resolves | **resolves** |

## Deployment and checks

**Without a session, after the deployment: 20/20 checks.** No real account was used; the recovery calls used unknown organizations or identifiers only.
- `/login` 200, with the « J'ai perdu ma clé d'accès » link.
- `/dashboard` redirects to `/login`.
- The protected APIs (checklist, journal, subjects, own sessions, own passkeys) answer 401.
- Passkey sign-in begin gives the same shape for an unknown organization and an unknown identifier.
- `/login/recovery` 200, with the code field.
- `/recovery` without a recovery session redirects to `/login`.
- Recovery sign-in, for an unknown organization, an unknown identifier at Legrand and a malformed body, gives the same 401 `LOCAL_AUTHENTICATION_FAILED`, takes at least 400 ms and sets no cookie.
- Recovery enrolment begin and complete answer 401 `RECOVERY_SESSION_INVALID`.
- `/api/me/recovery-codes` answers 401 for read, generation and revocation.

The Production database was read again after the deployment: data, functions, grants, 23 migrations and 0 codes all unchanged, and Legrand's session resolves under the new code.

**No rollback was needed.**

## R6 ceremony, on a dedicated test organization

**The test organization** was chosen by the operator. It is new and isolated from Legrand Tech and from the Lab reserved for B4.
- **Signup code:** `a3405279-3da1-459c-b21a-fc65b69219a5`, issued 14:16:50Z with the note "certification B2 R6". Single use, valid 24 h, it was the only Production write before the ceremony.
- **Signup:** the code was consumed at 14:24:15Z by the operator's own signup, with a Windows Hello passkey.
- **Organization:** `luxia-cert-b2-r6` « LUXIA certification B2 » (`08ec117a-fb9e-402d-b6ee-99081c406511`).
- **Its one person:** « Test récupération B2 », identifier `test.recuperation.b2`.
- **Isolation:**
  - 1 tenant, 1 LUXIA local connection (no Microsoft), 1 person, 1 account;
  - 0 domain, 0 invitation, 0 resource;
  - the founder's 21 administrator assignments exist in this organization only, as for any signup.

**Timeline** (2026-10-12, UTC, read from the database):

| Time | Event | Result |
|---|---|---|
| 14:34:57 | Passkey sign-in | FULL session, VERIFIED passkey evidence with user verification |
| 14:35:26 | Batch generated, 29 s after the sign-in (R2) | 10 codes, 1 batch; `RECOVERY_CODES.GENERATE` (10 codes, 0 revoked) |
| 14:37:01 | Sign-out | `SESSION.SIGN_OUT`; no open session |
| 14:46:43 | Recovery sign-in with one code | RECOVERY session of **exactly 900 s**; the code is used at the same instant; VERIFIED evidence `CUSTOM` / LOW / user not verified; `RECOVERY.SIGN_IN` |
| 14:47:56 | New passkey (Windows Hello) | In one transaction: recovery session ended, previous passkey **REVOKED**, new passkey **ACTIVE**; `RECOVERY.PASSKEY_ENROLLED` (1 passkey revoked, 0 other open session) and `LOCAL_AUTHENTICATOR.ENROLL` |
| 14:49:12 | Sign-in with the new passkey | FULL session; the R5 notice is shown on the overview (operator screenshot) |
| 14:56:54 | Sign-out | `SESSION.SIGN_OUT` |
| 14:57:04 | The used code tried again | **Refused**: generic answer, REJECTED evidence `RECOVERY_CODE_INVALID` |
| 14:58:06 → 14:58:25 | Second recovery cycle, with another code of the same batch | Conforming as well: RECOVERY session, then the passkey replaced again (1 revoked) |
| 15:02:20 | Sign-in with the newest passkey | FULL session |
| 15:04:01 | New batch (R5 rotation) | 10 new codes; the 8 unused codes of the first batch revoked |
| 15:06:25 | « Révoquer tous mes codes » | 10 codes revoked |
| 15:06:59 | Sign-out | `SESSION.SIGN_OUT` |

**What the ceremony proves:**
- **Single use:**
  - each code opened at most one session;
  - the used code was refused when tried again;
  - the database guard keeps used and revoked codes frozen.
- **RECOVERY session of 15 minutes:** both recovery sessions lasted exactly 900 s at creation, and each ended at its enrolment, after 73 s and 19 s.
- **R4:** each enrolment replaced the passkey (2 revoked, 1 active at the end) in the same transaction as the end of the recovery session. Other open sessions of the account would be revoked there too; there were none.
- **R5:** the remaining codes stayed valid after a recovery (the second cycle used one). The notice stayed until the new batch at 15:04:01, which revoked the 8 remaining codes.
- **Final state:** 0 usable code, 0 open session, 31 journal events and 6 sign-in evidence records.

**Not independently observed.** During the recovery session, `/dashboard` and `/api/me/sessions` were expected to refuse. These refusals leave no trace in the database, Vercel keeps no history of requests, and the operator did not report what the browser showed:

> Production browser refusal not independently observed during R6; behavior is covered by CI and clone certification. No security failure observed.

**Note on a failed attempt.** Before the first sign-in, the test identity had 1 failed attempt counted. The most likely cause: Windows Hello lists every passkey of the site, and a Legrand passkey was picked for the test identity. The counter went back to 0 at the next successful sign-in. The identity locks only at 5 failures.

## Neutralization of the test organization

At **15:18:29Z**, `luxia-cert-b2-r6` was moved to **SUSPENDED** with the B3 operator primitive `transitionOrganization`, never with generic SQL.
- A dry run (read only) first confirmed the organization id, the slug, its link to the consumed R6 signup code and its state (ACTIVE, 0 open sessions).
- The transition ran in one owner transaction: governance lock, status change, revocation of open sessions (0), then `SET CONSTRAINTS ALL IMMEDIATE`.
- The committed state was then re-read (finding P1): **SUSPENDED**, with the change time set by the database, and 0 open sessions.
- Nothing was deleted: 31 journal events, 6 sign-in evidence records, every code, passkey and session kept.
- **The suspended organization now answers exactly like an unknown one** at passkey sign-in, at recovery sign-in, and at Microsoft sign-in (`/login?error=signin`).
- It is **not CLOSED**. Its final closure belongs to the B4 operator procedure.

## Legrand Tech and the Lab stayed unchanged

- **Clone:** the fingerprint of every Legrand and Lab row, across all organization-scoped tables, was identical before and after the functional tests and the rollback with data.
- **Production migration and deployment:** the business digest of the 48 tables was identical before and after the migration, and again after the deployment. Legrand's open session resolved throughout.
- **R6 and the neutralization:** the same fingerprint was identical at every read:
  - the reference after the signup (14:26Z);
  - after each phase of the ceremony;
  - just before and just after the suspension.

  Both organizations stayed ACTIVE.

## Backups and rollback available

- **Application:** `dpl_8YEyT71Z1o3CUfb8qSCTZ9V1dr6o` @ `8aec711` (B3). It is compatible with the migrated schema: it ignores the new columns, never writes recovery codes and resolves FULL sessions only.
- **Database:** `docs/operations/B2-RECOVERY-CODES-ROLLBACK.sql`, rehearsed twice on the clone (empty and with data). Not one revoked code becomes usable again.
- **Neon backups:**
  - `br-dawn-scene-ahdunopo` (before B2, until 2026-10-26);
  - `br-cold-bread-ah1hlohl` (before B3) and `br-twilight-wildflower-ah68mp0p` (before status and scope), both until 2026-10-25;
  - the Lab archive `br-icy-darkness-aho1v83p`, kept until B4 is certified.
- **Test organization:** SUSPENDED, which is reversible. Its final closure is left to B4.

**FIRST ADMIN / BREAK-GLASS V1, B2 RECOVERY CODES AND RECOVERY-ONLY SESSION: PRODUCTION RELEASE PASS**

## Next

**B4, design only**, before any code. It covers:
- the operator break-glass procedure (dry run, plan digest, confirmation, journal event);
- final closure (CLOSED);
- the replay of the Lab neutralization on a clone of the archive `br-icy-darkness-aho1v83p`;
- the future closure of `luxia-cert-b2-r6`.
