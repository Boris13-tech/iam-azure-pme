# The backup job on Azure Container Apps

| Item | State |
|---|---|
| Status | **Prepared, not deployed** (2026-10-23). Deployment and cutover are operator gates |
| Why | The backup job runs on GitHub-hosted runners. It holds Production data **in clear, in memory**, between `pg_dump` and encryption. GitHub's data protection agreement covers paid plans only (verified 2026-10-23), so GitHub processes Production personal data with no DPA. That is a G8 blocker for any pilot |
| Decision | Run the same job, unchanged in substance, as a scheduled **Azure Container Apps job** in the operator's subscription (EU, France Central), where the backups and their alerts already are. The Microsoft DPA for pay-as-you-go online services is an ASSUMPTION for counsel to confirm ([hosting decision](../../PRIVATE_BETA_READINESS.md), item 11) |
| Cost | €0 expected: consumption plan, no charge while idle. About 720 runs a month × 90 s × 0.5 vCPU ≈ 32,400 vCPU-s and 64,800 GiB-s, within the monthly free grant (180,000 vCPU-s, 360,000 GiB-s). Logs: a few KB a day into the existing workspace (free allowance). The image is public on GHCR (free for public packages). No container registry is bought |

## 1. What changes, and what does not

| | Before (GitHub) | After (Azure) |
|---|---|---|
| Where Production data is in clear | A GitHub-hosted runner | The job's replica in the operator's subscription, discarded after each run |
| Trigger | Logic App `luxia-backup-dispatcher` → GitHub `workflow_dispatch`, with GitHub's own schedule as a fallback | The job's own schedule (`53 * * * *` UTC). The dispatcher and the GitHub workflow are switched off at cutover |
| Database credential | GitHub environment secret | Secret `backup-database-url` in the backup vault `luxia-bkp-kv-284e`, read at run time by the job's identity. Not a deployment parameter |
| Storage credential | A stored SAS (create + read) | **None stored**: a user-assigned managed identity with a custom role that can **create and read** blobs in `prod-backups` only (no delete, no list) |
| Script | `scripts/backup/backup.mjs` | The same. It now also accepts the managed identity when the container URL carries no SAS (`scripts/backup/azure-token.mjs`) |
| Encryption | `age` to the backup public key | Unchanged. The job never holds the private key |
| Freshness alert | `luxia-backup-freshness` | Unchanged: it counts manifests written, whoever writes them |
| Image | n/a | `infra/backup/Dockerfile`, base pinned by digest, non-root, only `scripts/backup/`. Built by `.github/workflows/backup-image.yml` on `main`, with a build provenance attestation. The job runs it **by digest** |

The image build runs on GitHub but never sees Production data or a Production secret.

## 2. Cutover (operator gates, in order)

1. **Merge** this change after independent review (class A: backup chain, CI/CD, Production configuration).
2. The image workflow runs on `main`. Note the digest it prints. Make the GHCR package `luxia-backup` **public** (package settings; it holds public code only), so that the job pulls it without a registry credential. Verify the attestation: `gh attestation verify oci://ghcr.io/boris13-tech/luxia-backup@sha256:<digest> --repo Boris13-tech/iam-azure-pme --source-ref refs/heads/main --signer-workflow Boris13-tech/iam-azure-pme/.github/workflows/backup-image.yml --source-digest <the reviewed commit>`.
3. Register the resource provider (free, subscription setting): `az provider register -n Microsoft.App`.
4. Put the database URL of `luxia_backup` (direct endpoint, from the Neon console) into the vault as `backup-database-url`. Never print it; type it through a prompt, not a command line.
5. Deploy: `az deployment group create -g luxia-backup-rg -f infra/backup/backup-job.bicep -p image=ghcr.io/boris13-tech/luxia-backup@sha256:<digest>`. The output `jobDeployed` must be `true` (the template refuses an image that is not pinned by digest).
6. Run once by hand: `az containerapp job start -g luxia-backup-rg -n luxia-backup-job`. Check the execution succeeded, a new manifest exists under `prod-backups/prod/`, and the freshness alert stays green.
7. **Restore drill from that backup** on a disposable database ([backup runbook](BACKUP-RUNBOOK.md), section 3): row counts and hashes identical.
8. Observe 24 hours: 24 executions, 24 manifests, no alert. Both jobs may write during this window; each backup has its own path.
9. Switch off GitHub: disable the Logic App `luxia-backup-dispatcher`; remove the schedule and the backup job from `.github/workflows/backup.yml` (a reviewed PR); delete the GitHub environment secrets `LUXIA_BACKUP_DATABASE_URL` and `LUXIA_BACKUP_CONTAINER_URL`; revoke that SAS (rotate the storage account key that signed it, or let a short SAS expire).
10. Update `docs/legal/SUBPROCESSORS.md` (GitHub no longer processes Production data) and the evidence store.

## 3. Rollback

Until step 9, rolling back is removing the Azure job (`az containerapp job delete`: stopping an execution leaves its schedule) and checking that no further execution starts, while the GitHub path keeps running. After step 9, also recreate the GitHub environment secrets, issue a fresh create-and-read SAS, re-enable the dispatcher, restore the workflow from git history, and require one verified backup before calling it done. In every case, the locked 30-day immutability keeps all existing backups.

**Permissions to prove at the cutover drill (not verified until then):** the identity creates new blobs with `blobs/add/action` and without `blobs/write`, a first backup must succeed, and a PUT on an existing path must be refused. It can still list the container through `blobs/read`.

## 4. Threat model (short, STRIDE)

| Threat | Mitigation |
|---|---|
| Spoofing: someone runs the job with another image | The job runs one image **by digest**; the image is built on `main` only, with a provenance attestation verified at cutover. Changing the image is a new deployment (operator) |
| Tampering with backups | The identity has no delete; the container's immutability is locked for 30 days; a backup is read back and hash-compared by the job itself |
| Information disclosure: the database URL | In the vault, readable by this identity only (role on that secret). Not in the image, the template, the logs or GitHub after cutover. The script prints no row count, connection detail or secret |
| Information disclosure: backup content | Encrypted to the public key before upload; the private key is offline with the operator |
| Elevation: the identity used for something else | Custom role with three blob data actions on one container; the secret role on one secret. No management action |
| Denial of service: the job stops | Freshness alert at 3 hours (Azure), plus the second watcher of monitoring slice 4; emergency catch-up from the operator's workstation ([backup runbook](BACKUP-RUNBOOK.md), section 2) |
| Supply chain: base image or apt packages | Base pinned by digest; PostgreSQL client from the PGDG repository with its signing key; `age` from Debian. The image changes only through a reviewed change on `main` |
| Common mode: Azure holds the backups and now runs the job | Accepted: the backups' independence is from the **database provider** (Neon), which is unchanged. The restore drill proves the backups are usable |
