# E1 INDEPENDENT BACKUP AND DRILL B (LOSS OF THE DATABASE): PRODUCTION PASS

Date: 2026-10-13 (UTC).
- Design: `docs/operations/INDEPENDENT-BACKUP-ARCHITECTURE.md`.
- Runbook: `docs/operations/BACKUP-RUNBOOK.md`.
- Code: PR #57, merged as `2999b0d`.
- Operator approval: the decisions of 2026-10-13 (spend ceiling €10 a month, backup role, age key), then the Production sequence, confirmed directly.

## The claim, and what proves it

> **A complete loss of the Production database can be recovered from an independent backup.**

**Measured on 2026-10-13, with the real Production backup:**
- **RPO 2 min 7 s:** the data was 127 s old when the loss was declared.
- **RTO 81 s:** from declaring the loss to a restored database that is verified and ready for the application.

**The drill started from three things only:**
1. the encrypted backup in Azure (France Central);
2. the private key file;
3. an **empty** Neon project in Frankfurt, in a different Neon organization from Production.

It used nothing from the Production database or its Neon project.

**What this does not prove yet** (section 8):
- switching the application to the restored database: **not rehearsed**;
- full-service RTO: **ASSUMPTION**, it adds the Vercel environment change and a redeploy;
- the key custody and the immutability lock: waiting for the operator.

## 1. The backup role (`luxia_backup`)

**Is BYPASSRLS really needed?** Answered first on a non-Production Neon branch with 38 synthetic organizations, then confirmed in Production.

| Case | Result |
|---|---|
| Without BYPASSRLS, `pg_dump` as shipped (row security off) | **Stops**: `query would be affected by row-level security policy for table "AccessReviewCampaign"` |
| Without BYPASSRLS, reading with row security on | Organization 38, but **0** subjects, accounts, passkeys, recovery codes, assignments, journal events, sign-in evidence and sessions |
| Without BYPASSRLS, `pg_dump --enable-row-security` | **Exit 0, a silent partial backup**: 38 organizations and 0 rows in every tenant table |
| With BYPASSRLS | Every count equals the owner's (for example 352 recovery codes, 77 journal events) |

**Verdict:** BYPASSRLS is required, and the backup refuses to run without it.

**Production checks, 2026-10-13 12:51Z, 6 out of 6** (`role-verify.mjs`):
- **attributes:** NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOINHERIT, BYPASSRLS, LOGIN, 3 connections, member of no role, `default_transaction_read_only=on`;
- **privileges, 51 tables:** missing SELECT 0, any write right 0, grantable 0;
- no CREATE on the schema or the database, and no LUXIA function it can execute;
- **complete read:** owner and `luxia_backup` on the same exported snapshot see identical counts in all 51 tables (1,501 rows);
- **16 out of 16 real attempts refused**, each in a transaction switched to READ WRITE. They covered UPDATE, DELETE, INSERT and TRUNCATE on the organization, journal, evidence and session tables; `SELECT … FOR UPDATE`; `LOCK … ACCESS EXCLUSIVE`; CREATE TABLE and ALTER TABLE; disabling the T0 trigger; DROP TABLE; CREATE SCHEMA and CREATE ROLE; `ALTER ROLE app_user BYPASSRLS`; and `SET ROLE neondb_owner`;
- by default, a write stops with `cannot execute UPDATE in a read-only transaction`.

**Inventory before and after the role was created** (owner, read only):
- every table has the same rows and the same content hash;
- the only differences are `luxia_backup:SELECT` in the table privileges, its default privileges, and the role itself.

**Credential:**
- created by `set-backup-password.mjs`: never printed and never on a command line. Neon refuses SCRAM verifiers, so the password travels over TLS through standard input;
- stored only in the GitHub environment secret `LUXIA_BACKUP_DATABASE_URL` (environment `production-backup`, released to `main` only). The local file was deleted;
- rollback: `docs/operations/BACKUP-ROLE-ROLLBACK.sql`.

## 2. The storage

Azure Blob Storage, France Central:
- zone-redundant;
- versioning;
- version-level immutability, 30 days;
- soft delete, 14 days;
- a deletion lock on the resource group.

The choice is explained in the architecture document, section 3.

| Attempt | Result |
|---|---|
| Job credential: create a new file | 201 |
| Job credential: overwrite it | **403 UnauthorizedBlobOverwrite** |
| Job credential: delete it, or list the container | **403** |
| **Owner credential with every permission: delete the protected version, or the file** | **409 BlobImmutableDueToPolicy** (protected until 2026-11-12) |
| A revoked job credential | **403 AuthenticationFailed** |

## 3. The first Production backup

Run [38402668665](https://github.com/Boris13-tech/iam-azure-pme/actions/runs/38402668665) on `main` (`2999b0d`):
- started by hand; the schedule then takes over (6 hours at first, 2 hours since the addendum below);
- backup `20261013T130923Z-e8e8e8`, snapshot at **13:09:23.016Z**, key `age-x25519:686d7b74344c34c5`.

| Measure | Value |
|---|---|
| Inventory, in the dump's snapshot | 3.8 s |
| `pg_dump` and encryption, streamed (the clear dump never touches the runner's disk) | 7.4 s |
| Upload | 2.1 s |
| Download again and compare the SHA-256 | 1.3 s |
| Total | **16.4 s** |
| Size | 454,533 bytes clear, 454,829 bytes encrypted |
| Scope | 51 tables of the LUXIA schema. `neon_auth` (Neon Auth, unused by LUXIA: 0 user, 0 session, one platform setting row) is left out and named in the manifest. Any other schema stops the backup |
| Public log | Scanned: no connection string, host name, SAS or key. The 4 secret values are masked by GitHub |

## 4. Drill B: timeline

| Time (UTC) | Elapsed | Step |
|---|---|---|
| 13:11:30.386 | 0 s | **Loss declared** |
| | 5 s | Blank target answering: Neon branch `br-raspy-frost-b9j52do9`, child of the empty root of project `twilight-surf-92910090` (Frankfurt). It expires on 2026-10-16 13:11:30Z, so the copy deletes itself |
| | 13 s | Read credential for the backups (read and list, 4 hours), generated from the operator's Azure access |
| | 51 s | **Restored and identical to the backup** (detail in section 5) |
| 13:12:50.958 | **81 s** | **Behaviour verified on the real data, migrations up to date** (section 6) |

**Inside `restore.mjs`:**
- download and hash check: 1.7 s;
- blank-target check: 0.3 s;
- roles: 0.9 s, creating `app_user` and `luxia_backup` without login;
- decryption into `pg_restore`, in one transaction: 30.3 s, bound by the latency between the operator's workstation and Frankfurt;
- ANALYZE: 0.6 s;
- inventory of the restored database: 3.4 s.

**Left out of the restore, on purpose:** the 2 default-privilege entries of Neon's platform role `cloud_admin`. They already exist on any Neon target, and the comparison below shows them identical.

## 5. Integrity: the restored database against the backup's own inventory

The inventory was taken **inside the dump's snapshot** and travels encrypted with it. The restored database was compared with it line by line. Result: **0 differences**.

| Checked | Count | Result |
|---|---|---|
| Tables, with the row count **and the SHA-256 of their whole content** | 51 tables, 1,501 rows | identical |
| Columns: type, nullability, default, identity, collation, privileges | 583 | identical |
| Constraints, with their validated, deferrable and deferred state | 218 | identical |
| Indexes, with their validity | 184 | identical |
| Triggers, including T0's 4 append-only triggers, with their enabled state | 19 | identical |
| Functions, with a hash of the definition, SECURITY DEFINER, search_path, owner and EXECUTE rights | 22 | identical |
| Row-level security: the RLS and FORCE flags of every table, and the 35 policies (command, roles, expressions) | 35 | identical |
| Table privileges, including `app_user`'s narrowed rights and T0's revocations | 51 | identical |
| Enum and other types | 41 | identical |
| Default privileges, including the global rule that new functions are not executable by PUBLIC | 5 | identical |
| Security attributes of the referenced roles | 6 | identical |
| Migrations (`_prisma_migrations`, 25 applied, last `20261013090000_audit_append_only`) | 25 | identical; `prisma migrate status`: *Database schema is up to date!* |
| Large objects | 0 | identical |

**The business data is covered by these content hashes:**
- organizations;
- identities: subjects, accounts, local identities;
- permissions: assignments, entitlements, roles;
- passkeys and recovery codes;
- the administration journal and the sign-in evidence.

**Restored totals:**
- 3 organizations: 1 active, 2 closed, which are the certification organizations;
- 8 active passkeys and 20 recovery codes;
- 479 journal events, 54 sign-in evidence rows and 125 sessions.

## 6. Behaviour on the restored real data

**`verify-restored.mjs`: PASS.**
- `app_user` is the runtime role, without BYPASSRLS.
- **Isolation:**
  - without a tenant scope, `app_user` sees **0 rows** in all 35 tenant tables;
  - in each of the 3 real organization scopes, it sees **exactly** the rows the owner counts for that scope: 105 table-and-scope pairs, 917 rows, all identical.
- **Append-only, on real rows:**
  - **journal:** `app_user` UPDATE and DELETE are refused (no right), and the owner's are refused by `AUDIT_APPEND_ONLY`;
  - **sign-in evidence:** the same, 4 out of 4.

**The application's PostgreSQL suites, run on the restored real data** (11 suites, about 9 minutes):
- 88 passed, 8 skipped, **4 failed, all for reasons of the drill environment**:

| Test | Cause | Coverage elsewhere |
|---|---|---|
| Invitations: expired case (domains and invitations) | The test ages an invitation with `SET session_replication_role`, which only a superuser may set. Neon's owner is not one | Passes in CI on a restored database |
| Self-onboarding, requirements 8 and 9 | Same | Same |
| Organization status: backfill and rollback drill | The test builds a separate scratch database from the old migration files with `psql -f`. On this Windows workstation the path exceeds 260 characters (`No such file or directory`). It does not touch the restored database | Same |
| Self-onboarding, requirement 12 (scratch database) | Same | Same |

**The suites covered:**
- B1, last administrator;
- B2, recovery;
- B3, organization status, lifecycle and sign-in;
- B4, break-glass;
- T0, append-only;
- domains, invitations, onboarding and signup.

**CI on every change (job `backup-restore-roundtrip`, PostgreSQL 17):**
- the role tests;
- a backup;
- a restore into a blank database, identical (3,027 rows);
- `verify-restored` (112 scopes);
- then **all** of `test:resources` (206 passed) and `test:security` (196 passed) on the restored database.

## 7. RPO and RTO

| | Measured on 2026-10-13 | Design value |
|---|---|---|
| **RPO**, losing the Neon project or account | **127 s** (the backup was 2 min 7 s old) | **at most 6 hours** (the schedule), plus GitHub's scheduling delay, which is usually minutes and has no guaranteed upper bound |
| **RPO**, a mistake inside the Neon project | not measured (Drill A) | 6 hours of point-in-time history at Neon (Free plan) |
| **RTO, data layer**: from loss to a verified restored database | **81 s** | the same order at today's size. It grows with the dump size and with the latency to the target |
| **RTO, service**: application switched over | **not rehearsed** | ASSUMPTION: plus 5 to 15 minutes (Vercel environment variables and a redeploy) |
| Backup duration | 16.4 s | — |
| Cost | under €0.10 a month | ceiling €10 a month |

## 8. Remaining risks and the operator's actions

| # | Item | Severity | Owner |
|---|---|---|---|
| R1 | **The private key is on the workstation only** (`C:\Users\OWANDJA BORIS\.luxia-keys\`). If that disk is lost, every backup is unreadable. The two controlled copies (password manager, and a separate copy encrypted with a passphrase) must be made, then the workstation copy deleted (runbook section 4) | **P1** | **Operator** |
| R2 | The immutability policy is unlocked: an Azure administrator could shorten it. Locking it (compliance mode, 30 days) is irreversible | P2 | **Operator decision** |
| R3 | Switching the application to a restored database has not been rehearsed. It needs a non-Production deployment to point at the restored copy | P2 | Claude, next drill |
| R4 | No alert on backup freshness. GitHub e-mails on a failed run, but a schedule that never starts is silent, for example after 60 days without activity in the repository | P1 before the beta | Claude, Ops/Monitoring block |
| R5 | One copy at one provider (Azure). A second copy (Scaleway, EU law) would satisfy 3-2-1 | P3 | Later |
| R6 | A leaked `luxia_backup` credential reads every tenant. Mitigations in place: environment secret released to `main` only, rotation procedure, 3 connections, read-only. A Neon IP allow-list needs a paid plan | P2 | Rotation yearly |
| R7 | `luxia_backup` can still take advisory locks and create session-private temporary tables (PostgreSQL grants both to PUBLIC; not tested). With a stolen credential, holding the governance advisory lock of an organization could block that organization's administration writes while it is held. That is availability, not integrity: the role can change no LUXIA data | P3 | Accepted, documented; revisit with the Ops block |
| R8 | Deleted personal data stays in backups for up to 30 days. The privacy documents must say so (`docs/legal/DATA-RETENTION-AND-DELETION.md`) | P2 | Counsel |

## 9. Incidents during the work

- **A writer credential was shown in a tool output** while the storage was being set up, before the first backup. A check printed the whole SAS instead of its permissions.
  - Its access policy was deleted within minutes, and a replacement was created without being displayed.
  - Proven dead: `403 AuthenticationFailed`.
  - Nothing had been written with it except the probe file.
- **Drill B started three times.**
  - A path bug in the drill script (Windows), then a duplicate branch name, stopped the first two attempts before any restore.
  - The first attempt left an empty branch, `br-damp-tree-b99q7mna`, which expires on its own on 2026-10-16.
  - The timeline above is the third, complete run.
- **On Windows, `psql` ends its lines with CRLF.** It was found by the behaviour checks on the test branch and fixed in `pg.mjs`. Earlier results were checked as unaffected: those comparisons were string against string, or the lines were trimmed.

## Addendum, evening of 2026-10-13

- **R1, key custody: closed.**
  - The operator stored the key in the password manager.
  - A recovery copy was encrypted with a passphrase generated by `age` (scrypt, work factor 18). The operator wrote the passphrase on paper.
  - **Test:** the operator typed the passphrase from the paper to decrypt the copy. The result is identical to the original key (SHA-256 compared without display). The test file was removed.
  - The clear key was then deleted from the workstation (operator: "make the best choice"). Only the encrypted copy remains there.
  - The operator's statement, not verified by Claude: the password-manager copy.
- **R2, lock: closed** (operator: "make the best choice").
  - The container's immutability policy is **locked**: compliance, 30 days.
  - The versions of the first backup kept their "unlocked" version policies, so each was locked individually with the same expiry.
  - The next backup (`20261013T193259Z-bff074`) came out **locked** on its own, until 2026-11-12.
- **New P1 finding: GitHub dropped the first scheduled run** (2026-10-13 18:23Z; the workflow is active, but no run started). GitHub documents that scheduled runs can be delayed or dropped under load.
  - A manual run at 19:32:59Z restored freshness.
  - The schedule is now every 2 hours, so one dropped run leaves data at most about 4 hours old. This is a mitigation, not a fix.
  - R4 rises to P1, first item of the Ops block: an alert from outside GitHub when the latest backup is too old (dead man's switch).

## Evidence (operator workstation, not in Git)

`.tmp-probe/rehearsal/backup-prod/evidence/`:
- `prod-before.json`, `prod-after.json`: inventories around the role creation;
- `prod-role-verify.json`;
- `drill-b-restore.json`: full inventory comparison;
- `drill-b-verify.json`;
- `drill-b-migrate-status.log`;
- `drill-b-suites.log`, `drill-b-suites-rerun.log`;
- `drill-b-times.json`, `drill-b-console.log`.
