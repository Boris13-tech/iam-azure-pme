# Independent backup: runbook

How LUXIA backs up Production outside Neon, and how to restore it after losing the database. Design:
`INDEPENDENT-BACKUP-ARCHITECTURE.md`. Proof: `docs/certification/E1-BACKUP-RESTORE-DRILL-B-2026-10-13.md`.

## 1. What exists

| Part | Where | Notes |
|---|---|---|
| Backup role | `luxia_backup` in Production (`scripts/backup/luxia-backup-role.sql`) | SELECT only, read-only by default, BYPASSRLS (required, see the architecture), 3 connections at most. Rollback: `docs/operations/BACKUP-ROLE-ROLLBACK.sql` |
| Job | `.github/workflows/backup.yml`, started every hour at :53 UTC by the Azure Logic App `luxia-backup-dispatcher`, on demand, and by the GitHub schedule `23 * * * *` when it fires. A secretless gate job then backs up only if Azure missed its slot | Runs `scripts/backup/backup.mjs` in the GitHub environment `production-backup` (secrets released to `main` only). Public log: no count, no secret |
| Storage | Azure subscription of the operator, resource group `luxia-backup-rg`, account `luxiabackupfrd325`, container `prod-backups`, region France Central | Zone-redundant (3 zones). Versioning. Version-level immutability, 30 days. Blob and container soft delete, 14 days. Management lock `luxia-backup-no-delete` on the group |
| Writer credential | Secret `LUXIA_BACKUP_CONTAINER_URL` | Container SAS bound to the stored access policy `bw-202610-r2`: create and read only (no overwrite, no delete, no list). Expires 2027-10-13 |
| Database credential | Secret `LUXIA_BACKUP_DATABASE_URL` | `luxia_backup` on the direct endpoint (an exported snapshot cannot live behind the pooler) |
| Public key | `scripts/backup/recipient.txt` | age X25519, key id `age-x25519:686d7b74344c34c5` |
| Private key | Operator custody (section 4) | Never in Git, CI, Azure, Neon, Vercel, a backup or a log |

**One backup** is a folder `prod/YYYY/MM/DD/<id>/` with:
- `dump.pgc.age`, the `pg_dump` custom-format export, encrypted;
- `inventory.json.age`, encrypted: the row count and content hash of every table and the schema fingerprint, taken in the same snapshot as the dump;
- `manifest.json`, clear text, with no data and no secret: times, key id, sizes, SHA-256 of both files, migration count, and the platform schemas left out.

**Scope:** every schema except the declared platform schemas (`neon_auth`, the Neon Auth feature, unused by LUXIA). Any other schema stops the backup.

## 2. Watching it, and catching up

**What can go wrong:**
- **GitHub's scheduler is unreliable for this repository.** At diagnosis time (2026-10-13 22:10Z) it had never run: 0 scheduled runs since the repository was created, and 18:23, 20:23 and 21:23 were missed. Since then it ran once, at 2026-10-14 00:23Z, then missed 01:23 and 02:23. The hourly trigger is therefore in Azure (line 1). The GitHub schedule is a gated fallback: it backs up only when Azure missed (E4 certification, section 7).
- GitHub also disables scheduled workflows in a public repository after 60 days without activity.
- A job can fail: its database credential, its storage credential, or Neon can be down.

**Three lines of defence:**

| # | Mechanism | Covers | Outside GitHub |
|---|---|---|---|
| 1 | **Hourly trigger from Azure.** The Logic App `luxia-backup-dispatcher` starts `backup.yml` every hour at minute 53 UTC. A failed run is caught up by the next one. The GitHub schedule (`23 * * * *`) is a gated fallback: it backs up only if no dispatched backup succeeded in the last 50 minutes | One failed run: data stays about 1.5 to 2 hours old | **Yes** (the trigger) |
| 2 | **Azure alert `luxia-backup-freshness`**, detailed below | Two misses in a row, GitHub outages, disabled schedules, broken credentials, and a broken log pipeline | **Yes** |
| 3 | **Catch-up by the operator** on alert (below) | Everything that lines 1 and 2 report | Partly, see 3b |

**The alert (line 2):**
- Storage write logs (diagnostic setting `luxia-backup-writes`) go to the Log Analytics workspace `luxia-backup-logs` (resource group `luxia-backup-rg`, France Central, 30 days).
- Every 15 minutes, the scheduled query `luxia-backup-freshness` counts the backup manifests written under `prod-backups/prod/` in the last 3 hours (`PutBlob`, HTTP 201).
- **Zero** raises a severity-1 alert. The action group `luxia-backup-alerts` e-mails both of the operator's addresses.
- The alert resolves on its own when a backup lands, and sends a second e-mail.
- If the log pipeline itself stops, the count is zero too: **the alert fails loudly, never silently.**
- Delay between the last backup and the e-mail: 3 hours, plus up to 15 minutes of evaluation, plus the log ingestion delay (usually a few minutes).

**Catch-up when the alert arrives (line 3).** The commands are written for Git Bash or a Linux shell.

a. **GitHub works.** Start a backup by hand, then check that it succeeded:

```bash
gh workflow run backup.yml --ref main
```

   Or use the "Run workflow" button on the *Independent backup* workflow page.

b. **GitHub Actions does not work.** Back up from the operator's workstation with the owner role.
   - The dump stays read-only and is encrypted to the same public key. The private key is not needed.
   - You need: the PostgreSQL 17 client, `age`, Azure access, and the Production owner connection string.
   - Prepare a short upload credential (create and read, one hour):

```bash
az storage container generate-sas --account-name luxiabackupfrd325 --auth-mode key -n prod-backups --permissions rc --expiry <now + 1 h> --https-only -o tsv
```

   Then run the backup:

```bash
LUXIA_BACKUP_DATABASE_URL=<owner, direct endpoint> LUXIA_BACKUP_EMERGENCY_ROLE=neondb_owner LUXIA_BACKUP_CONTAINER_URL="https://luxiabackupfrd325.blob.core.windows.net/prod-backups?<token>" node scripts/backup/backup.mjs
```

   - Never inside GitHub Actions: the script refuses the owner role there.
   - The manifest records `"emergency": true`.

**Checking by hand** (after `az login`):

```bash
az storage blob list --account-name luxiabackupfrd325 --auth-mode key -c prod-backups --prefix prod/ --query "max_by([?ends_with(name,'manifest.json')], &properties.creationTime).{name:name,at:properties.creationTime}" -o table
```

**What the RPO is, honestly:**
- About 1 hour normally.
- About 2 hours when one run fails (line 1, automatic).
- Beyond that it depends on a human: the alert fires 3 hours after the last backup. The RPO is then 3 hours, plus detection (about 30 minutes), plus the operator's reaction time.
- **No hard maximum RPO is guaranteed.** That needs someone on call (E7), and a second watcher outside Azure: today the trigger and the alert share the same Azure subscription.

**The hourly trigger (line 1):**
- The Logic App `luxia-backup-dispatcher` (resource group `luxia-backup-rg`) has a system identity that may only read secrets of the Key Vault `luxia-bkp-kv-284e`.
- Every hour it reads the secret `github-backup-dispatch-token`: a fine-grained GitHub token for this repository only, with **Actions: read and write** only, expiring 2027-10-13. It then calls GitHub's API to start `backup.yml` on `main`.
- Inputs and outputs are hidden from its run history.
- **Enabling the Logic App runs it once immediately.**
- The token cannot run Production on its own: the GitHub environment `Production` only accepts `main`, requires the operator's approval, and admins cannot bypass it (E17, 2026-10-13).

**Rotating the dispatch token** (before 2027-10-13, or at once if it may have leaked):
1. create a new fine-grained token with the same settings;
2. paste it as a new version of the secret `github-backup-dispatch-token` in the Azure portal (Key Vault, Secrets);
3. revoke the old token in GitHub;
4. run the Logic App once and check that a backup starts.

**Testing the alert path (monthly, and after any change to the action group):**
1. Enable the rule `luxia-backup-freshness-drill`. It counts only markers under `prod-backups/drill/`, so it fires within 5 minutes.
2. Check that both addresses receive "Fired".
3. Write a marker `prod-backups/drill/<date>/<time>/manifest.json` (one-off create-only credential). The alert resolves about 15 minutes later.
4. Check that both addresses receive "Resolved".
5. **Disable the drill rule.** Otherwise it fires again one hour after the marker.

**E-mail recipients must be verified.**
- Azure Monitor sends nothing to an e-mail address whose status is `VerificationPending`. Only the API version `2026-03-01-preview` shows that status; the others show "Enabled".
- Verification links expire quickly, and the API has no resend operation.
- **Verify from the Azure portal:** open the action group, edit it, save it again, and click the links at once.

## 3. Restoring after losing the database

You need:
- the private key file;
- Azure access to the storage account;
- an empty PostgreSQL 17 database and its owner's connection string;
- the PostgreSQL 17 client and `age` installed.

Nothing else from the lost environment is needed.

1. **Note the time.** This is the decision time used to measure RTO and RPO.
2. **Create a blank target.** Today this means a new Neon project or branch in `aws-eu-central-1`, PostgreSQL 17, empty. The script refuses any target that holds a table.
3. **Get a short read credential.** It allows read and list, for 4 hours:

```bash
az storage container generate-sas --account-name luxiabackupfrd325 --auth-mode key -n prod-backups --permissions rl --expiry <now + 4 h, e.g. 2026-10-13T18:00Z> --https-only -o tsv
```

   Put it in `LUXIA_BACKUP_SOURCE_URL=https://luxiabackupfrd325.blob.core.windows.net/prod-backups?<token>`, never on a command line that is logged.
4. **Restore and prove.** With `LUXIA_RESTORE_TARGET_URL` set to the owner of the blank target:

```bash
node scripts/backup/restore.mjs --latest --identity <private key file> --report restore-report.json
```

   The script does the following, and stops at the first discrepancy:
   - checks the manifest hashes and the key;
   - creates the missing roles without login;
   - decrypts into `pg_restore` in one transaction, so the clear dump never touches disk;
   - compares the result with the inventory.

   `"identical": true` means every table, row and schema object matches the snapshot.
5. **Runtime credential.** Give `app_user` a new password on the target with `ALTER ROLE app_user LOGIN PASSWORD ...`, sent through standard input. Set `LUXIA_RESTORE_APP_URL`, then run:

```bash
node scripts/backup/verify-restored.mjs
```

   It checks that row-level security isolates every organization and that the journal stays append-only.
6. **Recreate the backup role** on the new database (`luxia-backup-role.sql`, then `set-backup-password.mjs`), then update the GitHub secret.
7. **Switch the application:**
   - set `DATABASE_URL` (runtime, `app_user`) and the migration URL in Vercel;
   - redeploy the current release;
   - check `/login`, the protected APIs, and an operator sign-in.

   This step has not been rehearsed yet (see the drill report).
8. **Tell customers** whose data is older than the backup, following `docs/legal/INCIDENT-RESPONSE-AND-BREACH-NOTIFICATION.md`.

**Rules of a drill:**
- the same steps, into a blank Neon branch with an expiry date, so that the copy deletes itself;
- the private key is used from the operator's workstation and the clear dump never touches disk;
- the report records the RPO, the RTO, every manual step and every failure.

Once a month, and before the private beta.

## 4. Key custody

The backup key is `age-x25519:686d7b74344c34c5`. It was generated on 2026-10-13 with `age-keygen` 1.3.2. Until the operator completes the steps below, it is at `C:\Users\OWANDJA BORIS\.luxia-keys\luxia-backup-2026-10.agekey`, readable by the operator's Windows account only.

**The operator keeps two controlled copies:**
1. **Primary:** the operator's password manager (a secure note holding the whole file, three lines).
2. **Recovery:** a separate copy, encrypted with a passphrase:

```bash
age --passphrase -o luxia-backup-2026-10.agekey.age luxia-backup-2026-10.agekey
```

   Keep it on a removable medium stored elsewhere. Keep the passphrase in a different place from that medium.

Then delete the workstation copy. Bring it back only for a drill, and delete it again afterwards.

- **Never:** in Git, in CI, in Azure, in Neon, in Vercel, in a backup, in a log, or in the same place as the storage credentials.
- **Rotation:**
  - every year, at once if the key may have been exposed, and when the person holding it changes;
  - generate a new key, replace `recipient.txt` (new key id), and merge;
  - **keep the old private key until the last backup encrypted to it has expired** (30 days today).
- **Later:** a key per backup wrapped by a KMS or HSM, and split custody when there is more than one operator. Post-quantum hybrid age recipients (`age1pq…`, age 1.3) once the backup runner ships age 1.3 or later.

## 5. Rotating the access credentials

- **Backup role password.** As the owner:

```bash
LUXIA_OWNER_DATABASE_URL=... node scripts/backup/set-backup-password.mjs <new file>
gh secret set LUXIA_BACKUP_DATABASE_URL --env production-backup < <new file>
```

  Delete the file afterwards. The old password stops working at once.
- **Writer SAS:**
  1. create a new stored access policy with `rc` permissions and a one-year expiry;
  2. generate the SAS from that policy;
  3. `gh secret set LUXIA_BACKUP_CONTAINER_URL ...`;
  4. **delete the old policy**, which revokes every SAS made from it at once. Proven on 2026-10-13: a revoked SAS gets `403 AuthenticationFailed`.

## 6. Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| `lacks BYPASSRLS` | The role was changed | Re-run `luxia-backup-role.sql` |
| `schema(s) X would be left out` | A new schema appeared | Grant it in the role file, or declare it as a platform schema in `inventory.mjs` (reviewed change) |
| `permission denied for table X` | A table was created by another role | Grant SELECT on it. The backup never skips a table |
| `upload ... refused: HTTP 403` | SAS expired or revoked | Section 5 |
| `does not match the manifest` (restore) | Corrupted or altered file | Use the previous backup, then investigate |
| `wrong key` (restore) | Backup made with another key | Use the key whose id is in the manifest |
| `differences between the backup and the restored database` | The restore is not faithful | Do not switch the application. Investigate the list in the report |

## 7. Cost

At today's size (encrypted dump under 1 MB, 24 backups a day kept 30 days, about 720 backups, under 400 MB):
- storage and operations: **well under €0.10 a month**;
- GitHub Actions minutes: free (public repository);
- Neon compute woken 24 times a day: about 15 CU-hours a month. In October the project used about 22 CU-hours a month in total, against 100 in the Free plan.
- Freshness alert: Log Analytics (a few MB of logs a month) and one log alert rule evaluated every 15 minutes, about €1.50 a month.

The authorized ceiling is €10 a month (operator decision, 2026-10-13).
