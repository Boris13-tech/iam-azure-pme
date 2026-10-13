# Independent backups: architecture, provider choice and key management

Status: **IMPLEMENTED and in Production** (2026-10-13, PR #57). The proof is in `docs/certification/E1-BACKUP-RESTORE-DRILL-B-2026-10-13.md`; operations are in `docs/operations/BACKUP-RUNBOOK.md`.

It follows the operator decisions of the same day:
- EU object storage, outside Neon and ideally outside the same account and failure domain;
- versioning or object lock;
- hash checks;
- a LUXIA-controlled key;
- at most €10 a month.

It implements E1 of `docs/product/ENTERPRISE-READINESS.md` and section 4 of `docs/operations/BACKUP-RESTORE-PLAN.md`.

**What changed from the design during implementation (2026-10-13):**
- **Storage:** Azure Blob Storage in France Central, not Scaleway (section 3).
- **Frequency:** every 6 hours, not daily.
- **Inventory:** the backup carries an encrypted inventory. It holds the row count and content hash of every table, and a schema fingerprint, all taken in the same snapshot as the dump. A restore is proven against it.
- **Scope:** the declared platform schema `neon_auth` is left out; any other unknown schema stops the backup.
- **Key:** the key pair was generated on the operator's workstation with `age-keygen`, not by the operator by hand. The private key was never displayed or read by Claude. Custody follows the runbook.

## 1. Chain

1. **Consistent export:** `pg_dump --format=custom` of the Production database, which runs in one snapshot transaction. It is read by a **dedicated read-only backup role**, because forced RLS requires BYPASSRLS to see every tenant.
2. **Compression:** pg_dump's own.
3. **Encryption:** `age`, with LUXIA's backup **public key**. The machine that runs the backup never holds the private key, so it can write backups but never read them.
4. **Hashes:** SHA-256 of the clear dump and of the encrypted file.
5. **Manifest:** time, duration, database size, migration count, business digest (the same digest the releases use), both hashes, key id. No secret.
6. **Upload:** to an EU bucket with versioning and **object lock in compliance mode**.
7. **Check:** re-download and compare the encrypted file's hash; on failure, an alert.
8. **Retention:** set by the lock and a lifecycle rule (section 4).
9. **Restore drill** (operator side, with the private key):
   1. download;
   2. check the hash;
   3. decrypt;
   4. `pg_restore` into a blank PostgreSQL 17;
   5. migrations, digest, application, sign-in, IAM and audit checks;
   6. measure RTO, RPO, backup and restore durations, backup size, cost, manual steps and failure points.

**Where the job runs:** a scheduled GitHub Actions workflow, every 6 hours (`.github/workflows/backup.yml`). It is outside Neon and outside the storage provider, it is logged, and it can alert on failure. **Its secrets:**
- the backup role's connection string;
- a storage credential **restricted to creating and reading objects in that one container** (no overwrite, no delete, no list, no lock change).

The age public key is not a secret.

## 2. Provider comparison

Dump size today is a few MB: the whole database is about 38 MB. Cost is therefore driven by minimum fees, not by volume. Sources are listed at the end. Where only third-party figures were found, they are marked ASSUMPTION.

| | **Scaleway** (FR) | **OVHcloud** (FR) | **Hetzner** (DE) | Backblaze B2 EU | Cloudflare R2 EU | AWS S3 eu-central-1 |
|---|---|---|---|---|---|---|
| EU region | Paris (Standard Multi-AZ, 3 zones), Amsterdam, Warsaw | Several EU regions, Paris 3-AZ (ASSUMPTION for the exact list) | Falkenstein, Nuremberg, Helsinki | Amsterdam (an account is tied to one region) | EU jurisdiction per bucket | Frankfurt |
| Company law | EU | EU | EU | US (CLOUD Act exposure) | US | US |
| Same failure domain as Neon? | No | No | No | No | No | **Yes**: Neon runs on AWS |
| S3 API | Yes | Yes | Yes | Yes | Yes (own lock API) | Native |
| Versioning | Yes | Yes | Yes (official page) | Yes | No classic versioning (ASSUMPTION) | Yes |
| Object lock | **Yes, compliance and governance** (official docs) | **Yes, WORM** (official docs) | Yes (official page) | Yes | Bucket locks | Yes |
| Encryption at rest | Yes (plus ours) | Yes (plus ours) | Yes (plus ours) | Yes | Yes | Yes |
| Storage price | €0.01606/GB-month Multi-AZ, €0.00803 One Zone, Glacier €0.00254 (official, Paris) | About €0.007–0.008/GB-month (ASSUMPTION, third party) | €6.49/month minimum including 1 TB (ASSUMPTION, third party) | About $0.007/GB-month (ASSUMPTION) | About $0.015/GB-month (ASSUMPTION) | About $0.0245/GB-month (ASSUMPTION) |
| Egress | 75 GB free each month, then €0.01/GB (official) | Sources disagree (ASSUMPTION) | 1 TB included (ASSUMPTION) | Free up to 3× stored (ASSUMPTION) | Free | Paid |
| Maturity for backups | Mature; S3 and lock for years | Mature | Object storage is recent; incidents reported mid-2026 (ASSUMPTION, third party) | Mature | Mature | Reference |
| Lock-in | Low (S3, standard tools) | Low | Low | Low | Medium (lock API differs) | Low |
| Cost at today's size | **< €0.10/month** | < €0.10/month (ASSUMPTION) | €6.49/month (minimum) | < $0.10/month | < $0.10/month | < $0.10/month |

## 3. Decision taken at implementation (2026-10-13): Azure Blob Storage, France Central

**DECISION:**
- Azure Blob Storage in France Central (Paris), in the operator's existing pay-as-you-go Azure subscription:
  - its own resource group, zone-redundant (3 zones);
  - versioning;
  - version-level immutability, 30 days;
  - soft delete, 14 days;
  - a deletion lock on the resource group.
- The job's credential can only create and read: it cannot overwrite, delete or list.

**Why not Scaleway, recommended below:** it needs a new account with a payment method. Claude may not create accounts or enter payment details, so it would have waited for the operator. Azure needed no new account, met every requirement, and costs cents.

**What was proven on the real container (2026-10-13):**
- the job's credential cannot overwrite a backup (`UnauthorizedBlobOverwrite`), delete it, or list the container;
- **an owner-level credential with every permission cannot delete a protected version** (`409 BlobImmutableDueToPolicy`) during its 30 days;
- a revoked credential gets `403`.

**ALTERNATIVES:**
- Scaleway, still the best fit for EU company law. Recommended as a **second, independent copy** later (3-2-1 rule): adding a destination is a configuration change;
- OVHcloud.

**IMPACT:**
- Microsoft (a US company) stores the backups. It **only ever sees ciphertext**: the key is LUXIA's, and the job holds the public half only. Exposure under the CLOUD Act is therefore limited to encrypted files.
- Microsoft Azure joins the subprocessors (`docs/legal/SUBPROCESSORS.md`).
- The subscription is shared with the operator's other projects. The deletion lock and the immutability limit what a mistake in another project can do.
- **The immutability policy is "unlocked" today.** A determined Azure administrator could still shorten it. **Locking it (compliance mode) is irreversible** and remains the operator's decision (`docs/operations/BACKUP-RUNBOOK.md`).

## 3b. Recommendation of the design phase (kept for the record)

**Scaleway Object Storage, Paris, Standard Multi-AZ, with a bucket created with object lock (compliance mode) and versioning.**

Why:
- EU company and law;
- three zones within the region;
- a different provider and failure domain from Neon (AWS);
- compliance-mode lock documented officially: even the account owner cannot delete or shorten a locked version;
- S3 tools, so the provider can be changed by configuration only;
- predictable price, near zero at our size.

Paris also keeps the backups apart from the target Production region (Frankfurt), while staying in the EU.

Why not the others:
- **OVHcloud** is a solid second choice, kept as the alternative if Scaleway fails a test;
- **Hetzner** has a fixed minimum that is pointless at our size, and its object storage is younger;
- **Backblaze, R2 and AWS** are US companies, and AWS is the same failure domain as Neon.

**Before use, to be proven on a test bucket:** a locked version can neither be deleted nor overwritten, even by the account owner, during its lock.

## 4. Retention

| Backup | Kept | Lock |
|---|---|---|
| Every 6 hours | 30 days | **in place:** version-level immutability, 30 days, *unlocked* (locking it is the operator's decision) |
| Monthly (the first of each month) | 12 months | **not in place:** the 12-month period must first be agreed with counsel, because deleted personal data survives in backups until they expire |

**Not in place yet:** a lifecycle rule that removes versions once their protection has expired. At today's size, keeping them costs less than a cent a month. It is added together with the retention periods agreed with counsel.

Personal data deleted in Production stays in backups until they expire. The retention policy and the privacy documents must say so (`docs/legal/`).

## 5. Key management, adapted to our stage

- **Algorithm:** `age` X25519, public-key encryption. It is simple and audited. No HSM now.
- **Two key pairs:**
  - the backup key (data);
  - a separate storage credential (access). They are never the same thing.
- **Public key:** in the repository and in the workflow. It is not a secret, and it can only encrypt.
- **Private key:**
  - generated on the operator's workstation with `age-keygen` (2026-10-13), written to a file readable by the operator's account only, never displayed;
  - never committed, never in a backup, never in a log, never in CI;
  - kept in **two places under LUXIA control**: the operator's password manager, and a separate copy encrypted with a passphrase on a removable medium (procedure: `BACKUP-RUNBOOK.md` section 4);
  - used only for restore drills and real restores.
- **Identification:** each manifest records the key id (a fingerprint of the public key). After a rotation, old backups stay readable with the old key, kept until they expire.
- **Rotation:**
  - every year;
  - at once if the key may be exposed;
  - when the person holding it changes.
- **Later:**
  - a cloud key manager (for example Scaleway Key Manager) or an HSM, when a customer or certification asks for it;
  - split custody (two people needed to restore) when LUXIA has more than one operator.

## 6. Steps and who decides

| Step | Owner | Done |
|---|---|---|
| Storage in the existing Azure subscription (spend under €0.10 a month, inside the €10 ceiling) | Claude | 2026-10-13 |
| Key pair, generated with `age-keygen` on the operator's workstation. The private key is never displayed, and its file is readable by the operator's account only | Claude | 2026-10-13 |
| **Move the private key into the password manager, make the encrypted recovery copy, then delete the workstation copy** | **Operator** | **pending** |
| Read-only backup role in Production (operator approval 2026-10-13, confirmed directly) | Claude | 2026-10-13 |
| The two secrets, in the `production-backup` environment of GitHub, released to `main` only | Claude | 2026-10-13 |
| Workflow, inventory, read-back check, restore and verification scripts, CI round trip | Claude | PR #57 |
| First real backup, then Drill B | Claude | see the drill report |
| **Lock the immutability policy (irreversible)** | **Operator decision** | **pending** |

## Sources

- [Scaleway Object Storage pricing](https://www.scaleway.com/en/pricing/storage/)
- [Scaleway, how to use object lock](https://www.scaleway.com/en/docs/object-storage/how-to/use-object-lock/)
- [OVHcloud, managing object immutability with Object Lock](https://docs.ovhcloud.com/en/guides/storage-and-backup/object-storage/s3-managing-object-lock)
- [Hetzner Object Storage](https://www.hetzner.com/storage/object-storage/)
- [Backblaze cloud storage data regions](https://www.backblaze.com/docs/cloud-storage-data-regions)
- [Cloudflare R2 bucket locks](https://codex-container-api-docs.previews.developers.cloudflare.com/r2/buckets/bucket-locks/index.md)
- Third-party price comparisons, used only where marked ASSUMPTION:
  - [Sliplane, cheap object storage in Europe](https://sliplane.io/blog/cheap-object-storage-providers-europe), which states a stake in the comparison;
  - [Infratally, S3 alternatives](https://infratally.com/articles/s3-alternatives-object-storage/).
