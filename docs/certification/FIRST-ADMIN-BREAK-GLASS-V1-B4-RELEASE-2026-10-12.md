# FIRST ADMIN / BREAK-GLASS V1, B4 OPERATOR BREAK-GLASS PROCEDURE: PRODUCTION RELEASE PASS

Date: 2026-10-12 (UTC).
- Design approved by the operator on 2026-10-12 (decisions D1 to D7 and Q1, recorded verbatim in section 12): `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-B4-OPERATOR-DESIGN.md` (PR #48).
- Implementation notes: `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1.md` (B4 section).
- Runbook: `docs/operations/B4-BREAK-GLASS-RUNBOOK.md`. Rollback of the B4 migration: `docs/operations/B4-BREAK-GLASS-ROLLBACK.sql`.

The operator approved each Production gate in chat, separately:
- the Production sequence on `2414ec6`: backup, migration, checks, deployment, smoke checks, then the two dry runs only;
- the closure of `luxia-certification-lab` alone, after reading both dry runs;
- the closure of `luxia-cert-b2-r6`, only after the journal-time fix (PR #50) was merged.

Approvals that arrived as pasted text were confirmed again by the operator, directly, in a structured question, before the step ran.

**How Production was read:**
- database reads ran in `READ ONLY` transactions, as the owner;
- the outputs are counts, statuses, operation names and hashes, with no session id, no token and no key material;
- the sign-in probes used unknown identifiers and a fake recovery code, so nothing was consumed or opened.

## What B4 changes

- **One operator command** (`scripts/operators/break-glass.ts`), never reachable from the application:
  - `plan` is a dry run in a `READ ONLY` transaction. It writes the plan file and prints its SHA-256 digest, valid 15 minutes;
  - `apply` takes the plan file and the digest, recomputes the plan under the locks, and refuses if anything changed.
- **Closed list of 7 actions:** suspend, reactivate and close an organization, revoke sessions, disable an account, release a domain, issue an emergency administrator invitation.
- **Authority matrix (D7 + Q1):**
  - `LUXIA_INCIDENT` may suspend and revoke sessions only;
  - `LUXIA_CERTIFICATION` applies only to the certification organizations named in the code;
  - `VERIFIED_CUSTOMER_REQUEST` needs two verification methods and the document hash, and applies only to the actions the request lists.
- **Irreversible actions** (close, disable an account) need the organization identifier typed again (`--irreversible <slug>`).
- **Journal:**
  - one `BREAK_GLASS.*` event per apply, written by the disabled SERVICE subject « Opérateur LUXIA (break-glass) », which has no account, assignment or session;
  - `changeId` = `break-glass:<digest>` and is unique, so a plan applies at most once;
  - the event records the reference, the reason, the counts before, the effects, and any earlier status change that was not journaled.
- **Emergency administrator invitation (D3):** the migration `20261012180000_break_glass_operator_invitation` adds `Invitation.issuedByOperatorChangeId`. The database lets only the operator role create one, sets its life to 24 hours, and accepts it only while its break-glass event exists.
- **D2:** a SUSPENDED organization may lose its last administrator through `DISABLE_ACCOUNT`. An ACTIVE one never can (B1).

## Releases

| Step | Reference | Result |
|---|---|---|
| Design | PR #48 `3cddf87` → **`dc64b9a`**, 17:19:13Z | CI PASS on `main` (run 38283415789) |
| B4 code | PR #49 `1c35251` → **`2414ec6`**, 18:41:56Z | Head CI PASS (run 38286027902, `break-glass-postgres` 8/8); CI PASS on `main` (run 38292675654) |
| Production migration | `20261012180000_break_glass_operator_invitation` | `prisma migrate deploy`, code `2414ec6`, owner, direct endpoint, **18:52:31Z → 18:52:40Z** |
| Production deployment | **`dpl_3Jm2usCcwnM4JZndgAU9A7ngkfnT` @ `2414ec6`** | READY 18:55:37Z, production target, built by Vercel from GitHub at the exact SHA. No env change |
| Rollback deployment | `dpl_CiB2VuvFtru15AxNJfa5NfDF8q2F` @ `fe34cf7` (B2) | READY |
| Journal-time fix | PR #50 `c7175ab` → **`41d7220`**, 19:29:35Z | Head CI PASS (run 38297420498, `break-glass-postgres` 9/9); CI PASS on `main` (run 38298006474). Not deployed: the application never imports the operator module |

**Before the merge of #49:**
- a local PGlite drill of the migration passed 21/21 checks. It found two real issues, both fixed before the merge:
  - the existing `Invitation_state` CHECK forced exactly 7 days, so the migration replaces it with 7 days or 24 hours;
  - a re-apply after a used rollback failed, so the new CHECK is added `NOT VALID` and validated when no older 24-hour row exists.
- the Lab replay and the Production-clone rehearsal below both passed.

## Lab replay on a clone of the archive

Neon clone `br-broad-star-ahuyyi7h` of the archive `br-icy-darkness-aho1v83p`, which holds the Lab exactly as it was before the provisional SQL neutralization of 2026-10-11. The clone was deleted after the replay.
- The B4 migration was applied first (24 migrations).
- The whole neutralization was replayed through the command only, under `LUXIA_CERTIFICATION`: suspend, revoke sessions, disable the founder, disable the member, release `cert.luxia-it.com` (TXT record absent on both resolvers), close.

| Lab | Archive | After the replay |
|---|---|---|
| Status | ACTIVE | **CLOSED** |
| Open sessions | 2 | 0 |
| Active accounts, local identities, passkeys | 2, 2, 2 | 0, 0, 0 |
| Domain `cert.luxia-it.com` | VERIFIED | LOST |
| Journal events | 47 | 53 (6 `BREAK_GLASS.*`) |
| SERVICE operator subjects | 0 | 1 |

Legrand's fingerprint was identical before and after.

## Production-clone rehearsal of the migration

Neon clone `br-old-star-ah61sx6g` of Production, with code `2414ec6`. Deleted after the rehearsal.

| Check | Result |
|---|---|
| Migration (15 s) | Business digest identical. **Only** `luxia_invitation_guard()` changed. `Invitation_state` validated |
| Rollback (`prisma db execute`) | **Exact**: digest and every definition identical to before |
| Re-apply | Identical to the first apply |
| Behaviour on the Production schema | B4 PostgreSQL suite 10/10 |
| Rollback with data | PASS: open operator invitations revoked first, then the previous guard and the 7-day CHECK restored |

## Production migration

| Check | Before | After |
|---|---|---|
| Backup branch | `br-snowy-dawn-ahbgmqhr`, 18:50:57Z, LSN `0/4070798`, no compute, expires 2026-10-26T12:00Z | |
| Migrations | 23, none failed | **24**, none failed |
| Business data | | **identical**; Legrand Tech and the Lab identical |
| Functions and triggers | | **only** `luxia_invitation_guard()` changed, identical to the rehearsal |
| `Invitation` | | column `issuedByOperatorChangeId` and CHECK `Invitation_operator_change_format` added; `Invitation_state` replaced and **validated**; 0 operator invitations |
| `app_user` and PUBLIC | | **No extra right**: same executable functions, table grants identical; `app_user` still NOSUPERUSER and NOBYPASSRLS |

## Deployment and checks

**Without a session, after the deployment: 20/20 checks** (the B2 smoke suite), plus:
- `/invitation` answers 200;
- invitation acceptance begin and complete with an unknown token answer 403 `INVITATION_INVALID`.

The database was read again after the deployment. Definitions, rights and migrations were unchanged.

**Data changed during the deployment window: the operator's own activity, proven read-only.**
- The global digest and Legrand's fingerprint changed between the migration and the post-deployment read.
- Every row of the append-only tables (journal, sign-in evidence, challenges, sessions) that existed before 18:53:16Z was identical.
- The new rows were one Legrand passkey sign-in at 18:54:00Z (one used challenge, one VERIFIED passkey evidence, one FULL session; the passkey's `lastUsedAt` and the local identity's `updatedAt` refreshed), then 6 journal reads from 18:54:01Z to 18:57:53Z (posture, checklist, subjects, domains, invitations, resource catalog).

**No rollback was needed.**

## Dry runs in Production

Both plans were computed at 18:58Z in `READ ONLY` transactions. Nothing was written.

| | `luxia-certification-lab` | `luxia-cert-b2-r6` |
|---|---|---|
| Action, reference | `CLOSE_ORGANIZATION`, `LUXIA_CERTIFICATION` `CERT-B4-PROD-LAB-20261012` | `CLOSE_ORGANIZATION`, `LUXIA_CERTIFICATION` `CERT-B4-PROD-R6-20261012` |
| Digest | `6064027f1f9f4d24b3c2b089da7149b8079f7da3144d32a15da917ec8b743d68` | `4a3cbf608d3f28477d0fe63f4ee046e4630885ea0c82f0715c4002c4fb2f8e9a` |
| Status | ACTIVE | SUSPENDED since 15:18:29.125Z |
| Counts | all 0 | 0 open session; 1 active account, local identity and passkey; 1 durable administrator |
| Operator subject | existing one reused | created at apply |
| Earlier unjournaled status change | none | SUSPENDED at 15:18:29.125Z (B3 primitive) |

**Four `BREAK_GLASS.*` events already existed in Production.** They are the provisional Lab neutralization of 2026-10-11 13:51:16Z, already documented in `docs/certification/CUSTOMER-SELF-ONBOARDING-V1-MULTI-ORG-CERTIFICATION-2026-10-11.md`. Their `changeId` values are 29 to 67 characters long, while a B4 `changeId` is always 76, so they can never collide.

## Closure of `luxia-certification-lab`

At **19:13:29Z**, after a new dry run, because the earlier plans had expired.
- The new plan (digest `f87092a2443ca6c800db7570d23dad0f381a942799d7f0651a578ada97204045`) was compared field by field with the earlier one. It was identical apart from the issue and expiry times.
- Apply: `LUXIA_CERTIFICATION`, `--irreversible luxia-certification-lab`; `changeId` `break-glass:f87092a2…`. ACTIVE → **CLOSED**, with 0 sessions, invitations and domains to touch.
- **Committed state re-read** (finding P1): CLOSED, 0 open session, 0 active account, 0 administrator. It matches the plan.

**Independent checks, per organization, before and after** (every organization-scoped table digested in full; journal and sign-in evidence compared row by row):
- **Legrand Tech: identical**, with no journal or evidence row added or changed.
- **`luxia-cert-b2-r6`: identical.**
- **The Lab:** only its status and `statusChangedAt` changed, and one event was added: `BREAK_GLASS.ORGANIZATION.CLOSE`, SUCCESS, by « Opérateur LUXIA (break-glass) ». Every other table is identical. Its history is kept: 4 sessions, 2 DISABLED accounts and local identities, 2 REVOKED passkeys, 1 invitation, 1 LOST domain, 4 sign-in evidence records and the 51 earlier journal events.
- **Unknown at sign-in, 3/3:** passkey sign-in, recovery sign-in and Microsoft sign-in answer exactly as for an organization that does not exist.

**Finding: the event time came from the operator machine's clock.** The event was timed 19:13:29.094Z and `statusChangedAt` 19:13:29.340Z.
- Cause: `occurredAt` used Prisma's `@default(now())`, which the client fills with its own clock, measured about 180 ms behind the database. The status trigger uses the database `now()`.
- Effect: none for the Lab, which is final. But a later plan on an organization changed by the procedure could report a journaled status change as unjournaled.
- The operator chose to fix this before the irreversible closure of `luxia-cert-b2-r6`.

## Journal-time fix (PR #50)

- `applyBreakGlass` reads `(now() AT TIME ZONE 'UTC')::timestamp(3)` in the apply transaction and passes it as the event's `occurredAt`. That is the same instant and clock as the trigger's `statusChangedAt`, with the same millisecond rounding.
- Nothing else changes: plan, digest, authority, effects, expiry, command. No migration.
- New tests:
  - `occurredAt` equals `statusChangedAt` exactly;
  - no plan after a status change made by the procedure sees an unjournaled change, including at each of the 6 steps of the Lab sequence;
  - the `luxia-cert-b2-r6` case (SUSPENDED by the B3 primitive, then CLOSED through the procedure) is flagged and recorded, at the database time, in UTC.
- **Not deployed**, because nothing in `lib` or `app` imports the operator module (architecture test), so the running application is the same. The command ran from a clean checkout of `41d7220`, whose tree is identical to the CI-tested head `c7175ab`.

## Closure of `luxia-cert-b2-r6`

At **19:32:00Z**, after a new dry run with the fixed command.
- The new plan (digest `1b492499dcdd4016e4926b7f1a71c42252562bd3e7ce079da2d731e5f9060793`) was compared field by field with the plan of 18:58Z. It was identical apart from the times and the tool version, which could change only to `41d7220`.
- Apply: `LUXIA_CERTIFICATION`, `--irreversible luxia-cert-b2-r6`; `changeId` `break-glass:1b492499…`. SUSPENDED → **CLOSED**, with 0 sessions, invitations and domains to touch.
- **Committed state re-read:** CLOSED, 0 open session. It matches the plan.

**Independent checks, per organization, before and after:**
- **Legrand Tech: identical.** **The Lab: identical**, still CLOSED.
- **`luxia-cert-b2-r6`:** only its status and `statusChangedAt` changed, the operator SERVICE subject (disabled) was created, and one event was added:
  - `BREAK_GLASS.ORGANIZATION.CLOSE`, SUCCESS, by « Opérateur LUXIA (break-glass) », tool version `41d7220`;
  - it records the earlier unjournaled suspension (`SUSPENDED`, 15:18:29.125Z);
  - **its time, 19:32:00.504Z, is exactly the organization's `statusChangedAt`.** The fix holds in Production.
- Its history is kept: 5 sessions, the test identity with its account, local identity and passkey, 2 REVOKED passkeys, 20 recovery codes (none usable), 6 sign-in evidence records and the 31 earlier journal events.
- **Unknown at sign-in, 6/6:** the three entry points answer as for an organization that does not exist, with an unknown identifier and with the real test identifier `test.recuperation.b2`.

## Final state

| Organization | Status | Open sessions | Journal |
|---|---|---|---|
| `legrand-tech` | ACTIVE | unchanged by B4 | unchanged by B4 |
| `luxia-certification-lab` | **CLOSED** (19:13:29Z) | 0 | 52 (4 provisional `BREAK_GLASS.*` of 2026-10-11, 1 B4 close) |
| `luxia-cert-b2-r6` | **CLOSED** (19:32:00Z) | 0 | 32 (1 B4 close) |

Production has 24 migrations, none failed. Nothing was deleted.

## Backups and rollback available

- **Application:** `dpl_CiB2VuvFtru15AxNJfa5NfDF8q2F` @ `fe34cf7` (B2). It does not know the new column, and no operator invitation exists.
- **Database:** `docs/operations/B4-BREAK-GLASS-ROLLBACK.sql`, rehearsed on the clone (empty and with data). The two closures are final by design (CLOSED cannot change, in the database).
- **Neon backups:**
  - `br-snowy-dawn-ahbgmqhr` (before B4, until 2026-10-26);
  - `br-dawn-scene-ahdunopo` (before B2, until 2026-10-26);
  - `br-cold-bread-ah1hlohl` (before B3) and `br-twilight-wildflower-ah68mp0p` (before status and scope), both until 2026-10-25;
  - the Lab archive `br-icy-darkness-aho1v83p`. B4 is now certified, and the operator chose to keep it until it expires on its own, on 2026-11-10. It is not deleted before.

**FIRST ADMIN / BREAK-GLASS V1, B4 OPERATOR BREAK-GLASS PROCEDURE: PRODUCTION RELEASE PASS**

## Next

**B5, visibility and posture**, design first.
