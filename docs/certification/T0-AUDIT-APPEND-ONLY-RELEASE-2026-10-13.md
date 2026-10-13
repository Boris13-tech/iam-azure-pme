# T0 AUDIT INTEGRITY: APPEND-ONLY JOURNAL AND SIGN-IN EVIDENCE, PRODUCTION RELEASE PASS

Date: 2026-10-13 (UTC).
- Design: `docs/architecture/LUXIA-OPERATOR-TRANSPARENCY.md`, section 5, T0.
- Rollback: `docs/operations/T0-AUDIT-APPEND-ONLY-ROLLBACK.sql`.
- Released under the low-risk Production rule (operator, 2026-10-12): it adds a protection, changes no data, has an exact rehearsed rollback, and passed the full CI. The operator approved T0 as a priority on 2026-10-13.

## What T0 guarantees, in exact words

`CanonicalAdminAuditEvent` and `AuthenticationEvidence` are **append-only. Modification is forbidden to the application role and to every ordinary statement of the owner role the LUXIA operator uses.**

**What T0 does not guarantee:**
- A privileged database owner can still disable or drop the guard, for example in a reviewed migration that is visible in the repository.
- **This is not cryptographic immutability.** Verifiable immutability (canonical payload, previous hash, event hash, checkpoint or signature) belongs to LUXIA Trust Ledger.

## Change

- Migration `20261013090000_audit_append_only`:
  - guard `luxia_audit_append_only` (error `AUDIT_APPEND_ONLY`), owner-only;
  - triggers on UPDATE and DELETE (per row) and on TRUNCATE (per statement), on both tables;
  - UPDATE, DELETE and TRUNCATE revoked from `app_user` and PUBLIC;
  - the resource-onboarding guard of 2026-10-08 stays.
- The CI bootstrap and the Production activation workflow revoke the same rights, so a re-run cannot give them back. The activation workflow also re-applies the self-onboarding narrowing it used to widen.
- Test cleanups use a helper that only works for a real superuser (`session_replication_role`). That exists in test databases only.

## Releases

| Step | Reference | Result |
|---|---|---|
| Code | PR #54 `3a3a060` → **`4d33a87`** | CI PASS. New PostgreSQL suite 4/4; the three adapted test cleanups pass; function privilege inventory updated (fail-closed) |
| Merge tree | `4d33a87` | Differs from the tested head only by documents (PRs #31 and #53) |
| Production migration | `20261013090000_audit_append_only` | `prisma migrate deploy`, owner, direct endpoint, **2026-10-13 07:28:30Z → 07:28:41Z** |
| Application deployment | none needed | No runtime code writes, updates or deletes these rows |

**Rehearsal.** The Neon branch quota is full and Docker Desktop did not start, so there was no clone rehearsal. The evidence is instead:
- **PGlite drill, 25/25** (`luxia-pglite/t0-drill.mjs`), on the full migration chain with the Production rights of `app_user`. It checks:
  - before T0, the gap is real;
  - the migration changes no data;
  - inserts still work;
  - the application's UPDATE and DELETE are refused;
  - the owner's UPDATE, DELETE and TRUNCATE are refused;
  - schema changes stay possible;
  - a data fix needs an explicit `DISABLE TRIGGER`;
  - **the rollback restores the exact previous state, and the re-apply is identical.**
- **CI on real PostgreSQL:** the whole chain plus every suite.
- **Read-only checks of Production before the migration:**
  - the rights of `app_user` were granted by `neondb_owner`, so the REVOKE applies;
  - `neondb_owner` owns both tables;
  - the function did not exist yet;
  - no long transaction was running;
  - `session_replication_role` needs a superuser, and `neondb_owner` is not one.

## Production checks (2026-10-13 ~07:30Z)

**Before and after the migration** (read-only snapshots):
- 24 → **25** migrations, none failed;
- business digest of every table **identical**;
- **only** `luxia_audit_append_only()` and its 4 triggers added;
- functions executable by `app_user` identical, nothing executable by PUBLIC;
- `app_user` still NOSUPERUSER and NOBYPASSRLS;
- organizations identical, and Legrand Tech's open session resolves through both resolvers.

**Rights:**
- `app_user` holds only INSERT and SELECT on the two tables;
- **every other table right is unchanged:** the previous state is rebuilt exactly by adding those 4 rights back;
- the 5 guards are enabled;
- the owner role cannot set `session_replication_role`.

**Real attempts, each in a transaction that is always rolled back, on rows of the CLOSED certification Lab:**

| Role | Attempt | Result |
|---|---|---|
| `app_user` | UPDATE and DELETE of a journal event | **refused**, `42501 permission denied` |
| `app_user` | UPDATE and DELETE of a sign-in evidence | **refused**, `42501 permission denied` |
| `app_user` | INSERT of a journal event (Legrand Tech scope) | **accepted**, then rolled back: nothing kept |
| owner (`neondb_owner`) | UPDATE and DELETE of a journal event | **refused**, `23514 AUDIT_APPEND_ONLY` |
| owner | UPDATE and DELETE of a sign-in evidence | **refused**, `23514 AUDIT_APPEND_ONLY` |

TRUNCATE was not attempted in Production. Its guard is proven by CI and the drill, and checked in the catalog.

**After the attempts:**
- every row of Legrand Tech, the Lab and `luxia-cert-b2-r6` is identical, journal and evidence compared row by row;
- nothing was added, changed or removed.

**B1 to B5 regression:**
- B2 smoke 20/20;
- the Lab and `luxia-cert-b2-r6` still answer as unknown organizations (3/3 each);
- B5: 44 journal operations, none unlabelled; Legrand Tech `recoveryCodes` still false.

**No rollback was needed.**

**T0 AUDIT INTEGRITY: PRODUCTION VERIFIED**
