# E4 BACKUP FRESHNESS: ALERT AND HOURLY TRIGGER OUTSIDE GITHUB, PRODUCTION PASS

Date: 2026-10-13 (UTC), evening.
- Operator requests:
  - finish E4 with an alert outside GitHub;
  - claim no maximum RPO until the alert and a catch-up work;
  - mark E4 PRODUCTION VERIFIED only when Fired and Resolved have been received on **both** addresses and the automatic resolution has been observed.
- Code: PR #60.
- Runbook: `docs/operations/BACKUP-RUNBOOK.md`, section 2.

## 1. What triggered this work

**At the time of the diagnosis, the GitHub scheduler had never run this workflow.**
- 0 runs with the `schedule` event in the repository's whole history (GitHub API, 2026-10-13 22:10Z).
- The `backup.yml` workflow is active, on `main`, and Actions is allowed.
- Slots missed: 18:23 (6-hour schedule), 20:23 (2-hour schedule), 21:23 (hourly schedule). The 21:23 slot was observed until 21:42 before concluding, at the operator's request.

**Consequence until this evening:** a backup happened only when someone started one.

**Observed since (addendum 2026-10-14, GitHub API, VERIFIED):**
- The scheduler ran once: `schedule` run `38489882851` at **2026-10-14 00:23:18Z**, success.
- The next slots, 01:23 and 02:23, did not run. As of 03:29Z, the scheduler has run 1 time in 4 hourly slots.
- **Second update, 2026-10-14 17:42Z (API, VERIFIED; the operator observed it first):** four `schedule` runs succeeded that day:
  - 00:23:18Z, run `38489882851`;
  - **06:15:51Z**, run `38521190168`;
  - **12:08:28Z**, run `38561595265`;
  - **17:22:02Z**, run `38606045268`.
- That is 4 of the 18 hourly slots from 00:23 to 17:23, at irregular times: the `23 * * * *` slots arrive up to about an hour late.
- With no gate merged, **each of them was an extra backup**, 4 that day. The scheduler is irregular, not absent.
- So "never ran" was true at diagnosis time, and is no longer true in absolute terms. The scheduler is **unreliable** for this repository, not absent.
- During 00:00 to 01:00, two backups were taken (00:23 by the schedule, 00:53 by Azure): the double backup that risk 5 below foresaw.

## 2. What is in place

| Part | What | Where |
|---|---|---|
| **Trigger, outside GitHub's scheduler** | Logic App `luxia-backup-dispatcher` (Consumption, France Central):<br>• every hour at minute 53 UTC, it starts the GitHub workflow `backup.yml` on `main`;<br>• its system-assigned identity reads the GitHub token from Key Vault `luxia-bkp-kv-284e` (RBAC role "Key Vault Secrets User" on that vault only);<br>• the inputs and outputs of both steps are hidden from the run history (`secureData`) | Azure, `luxia-backup-rg` |
| GitHub token | Fine-grained token created by the operator: repository `iam-azure-pme` only, permission **Actions: read and write** only, expires 2027-10-13. The operator pasted it into Key Vault; Claude never saw it | Key Vault secret `github-backup-dispatch-token` |
| GitHub schedule | Kept (`23 * * * *`) as a second trigger, should GitHub ever honour it. The workflow's concurrency group queues runs, so two triggers never run at once.<br>**Changed 2026-10-14 (decision A, section 7):** it is a gated fallback. A scheduled run backs up only if no dispatched backup succeeded in the last 50 minutes | `backup.yml` |
| **Freshness alert** | Scheduled query `luxia-backup-freshness`:<br>• every 15 minutes, it counts the backup manifests written in the last 3 hours (storage write logs, Log Analytics workspace `luxia-backup-logs`);<br>• **zero** raises a severity-1 alert to both addresses;<br>• it resolves on its own. A broken log pipeline also gives zero, so the alert fires | Azure |
| Alert drill | Scheduled query `luxia-backup-freshness-drill`: the same path, but it counts only markers written under `prod-backups/drill/`. **Disabled between drills** | Azure |
| Recipients | Action group `luxia-backup-alerts`: the operator's Gmail and `@legrand-tech.com` addresses, **both `Verified`** | Azure |
| Catch-up by hand | 3a: `gh workflow run backup.yml --ref main`.<br>3b: when GitHub Actions is down, `backup.mjs` from the workstation with the owner role (read-only dump, same public key) | Runbook |
| **E17, GitHub environment `Production`** | `main` only, the operator as **required reviewer**, `can_admins_bypass=false`. The dispatch token therefore cannot run a Production workflow on its own | GitHub |

## 3. Proofs in Production

**Alert path, cycle 1, invalid for delivery (kept for the record):**
- Production rule `luxia-backup-freshness`: Fired at **20:02:38Z** (no backup logged since the logs were connected).
- A catch-up backup **without GitHub** (3b) followed: `20261013T200344Z-3dd918` from the workstation, owner role, manifest `"emergency": true`, locked until 2026-11-12.
- The rule then **resolved on its own at 20:48:36Z**.
- First drill: Fired 20:31:27Z, marker at 20:32:41Z, Resolved 20:47:27Z.
- **No e-mail reached either address.** Both recipients were still `VerificationPending`. That status is visible only in the action group API version `2026-03-01-preview`; older versions show only "Enabled".
  - The verification links received earlier had expired.
  - The API has no "resend verification" operation, so recreating the recipients (21:08Z) and saving again (21:25Z) sent no usable new code.
  - **What worked:** the operator saved the action group again in the Azure portal and clicked both links at once. Gmail turned `Verified` at 21:41:58Z, `@legrand-tech.com` at 21:42:32Z.

**Cycle 2, after verification (the one that counts):**

| Step | Time (UTC) | Observed |
|---|---|---|
| Drill rule enabled | 21:42:58 | |
| **Fired** | **21:51:28** | Alert API |
| Marker written under `drill/` | 21:52:29 | HTTP 201 |
| **Resolved, on its own** | **22:07:29** | Alert API (three consecutive evaluations without a breach) |
| Drill rule disabled | 22:08 | |
| **E-mails** | | **Operator: "Fired" and "Resolved" received on Gmail AND on `@legrand-tech.com`, 4 out of 4** |

**Automatic trigger:**
- Enabling the Logic App ran it once at 22:37:01Z, plus one manual run at 22:37:04Z.
- Both read the token (OK) and started the workflow (`204 No Content`).
- Resulting backups: `20261013T223724Z-895108` and `20261013T223801Z-8f2c68`, both uploaded and read back.
- **First automatic hourly dispatch, 22:53Z:** **succeeded with nobody involved.** The Logic App run started at 22:53:04Z, the GitHub run `38480718296` at 22:53:06Z (`workflow_dispatch`), and backup `20261013T225329Z-55ae10` was uploaded and read back. GitHub's own scheduler still had 0 runs at the same time.

## 4. RPO, as it can honestly be stated now

| Situation | Data loss at most | Depends on |
|---|---|---|
| Normal | About 1 hour (dispatch at :53, about 1 minute to start, about 20 s per backup) | Nothing |
| One run fails (Neon, network, GitHub runner) | About 2 hours: the next hour catches up | Nothing |
| Two failures in a row, or a GitHub Actions outage | 3 hours to the alert, plus at most about 30 minutes (evaluation and log ingestion), **plus the operator's reaction** (3a or 3b) | **A human** |
| **Azure itself** fails (subscription, Logic Apps, Monitor) | **Not covered:** the trigger and the alert would stop together. GitHub only e-mails about failed runs, not about runs that never started | Remaining risk 2 |

**What can be claimed:**
- automatic recovery within about 2 hours from an isolated failure;
- an alert outside GitHub after 3 hours without a backup.

**What cannot be claimed:**
- **No hard maximum RPO is guaranteed.** That would need someone on call (E7), and a second watcher outside Azure.

## 5. Cost

All within the €10 a month ceiling:
- Logic App: about 720 runs × 3 executions, a few cents a month.
- Key Vault: a few hundred operations, under one cent.
- Log Analytics plus the alert rule: about €1.50 a month.
- The drill rule: about €0.30 a month while enabled.

## 6. Remaining risks

| # | Risk | Severity |
|---|---|---|
| 1 | Beyond about 2 hours, recovery depends on the operator's reaction (one operator, no on-call, E7) | P1 until E7 |
| 2 | **Common mode:** the hourly trigger and the freshness alert both live in the same Azure subscription. If the subscription is suspended (billing) or Azure Monitor and Logic Apps fail, both stop silently. Remedy: a second, minimal watcher outside Azure (for example a free external dead man's switch that the backup job pings), which needs an account the operator creates | P2 |
| 3 | The dispatch token expires on 2027-10-13. Rotation is in the runbook; until monitoring exists, there is a calendar reminder | P3 |
| 4 | The alert watches backups only. Application availability, errors and latency remain unmonitored (rest of E4) | P1 |
| 5 | GitHub's scheduler may start honouring the schedule later. There would then be two backups an hour (about 30 CU-hours a month at Neon, still inside the Free plan); watch it.<br>**Happened on 2026-10-14 at 00:23Z** (two backups in that hour). Closed by the gate (section 7): no extra backup while Azure works | P3, closed by the gate |

## 7. Two triggers: decision (2026-10-14)

**Facts:**
- Both triggers start the **same** executor: the GitHub Actions job in the `production-backup` environment.
- A second trigger therefore adds diversity on the **trigger** side only: Azure Logic App, Key Vault token and Azure scheduler on one side; GitHub's scheduler on the other.
- It adds nothing if GitHub Actions itself, the environment secrets or Neon fail. Those cases are covered by the alert and catch-up 3b.

| Option | Result | Verdict |
|---|---|---|
| **A.** Azure primary, GitHub schedule as fallback | Covers a missed Azure slot (Logic App, token or Key Vault fault) whenever GitHub's next scheduled run comes, often before Azure's next slot. Without a gate, it doubles the backups whenever GitHub's scheduler fires: **4 doubles on 2026-10-14** | **Chosen, with a gate** |
| B. Azure only | Simplest. A missed Azure slot waits for the next hour or for the alert | Acceptable, but gives up a free catch-up |
| C. Two independent triggers, both backing up | Two backups an hour when both fire, irregular because GitHub's scheduler is unreliable. Doubles Neon compute and immutable storage for no designed RPO | Rejected |

**How A is enforced (`backup.yml`, `scripts/backup/schedule-gate.mjs`, tested in `tests/security/backup-architecture.test.ts`):**
- **The gate job holds no secret.** It has no environment, and only `contents: read` and `actions: read`.
- A `workflow_dispatch` (Azure, or by hand) always backs up.
- A `schedule` run backs up only if no **dispatched** backup run succeeded in the last **65 minutes**: one hourly slot plus a margin.
  - The decision is taken when the scheduled run starts, whatever its delay. While Azure keeps its :53 slots, the last dispatched backup is always under 65 minutes old, so the gate skips.
  - After a missed Azure slot, it is more than 65 minutes old, so the gate backs up.
  - A scheduled run never proves a backup, because it may have skipped. Only dispatched runs count.
- **Why 65 and not 50 (first version of this PR):** the observed delays showed that a scheduled run can start at any minute.
  - With 50, a run starting between :43 and :53 would still have doubled.
  - **Replay on the real history** (`decide()` on the GitHub runs, 2026-10-14): the 4 scheduled runs of that day are all `skip` with 65, and the backups they made would have been avoided.
  - A run at :52 with Azure on time: `skip` with 65 (`back up` with 50).
  - A run at 19:10 after Azure missed 18:53: `back up` with both.
- **Fail-open:** if the run history cannot be read, the gate backs up. An extra backup is harmless; a missing one is not.
- The concurrency group still prevents two backups at once.

**Effect on the RPO:** about 1 hour normally, unchanged. After a missed Azure slot, it depends on when GitHub's next scheduled run comes (irregular), and at worst it waits for Azure's next slot: about 2 hours. Beyond that, the alert and the operator. Still no hard maximum.

**Status of the gate:** `IMPLEMENTED` once merged. **`PRODUCTION VERIFIED` only after a real `schedule` run on `main` is observed applying it.**
- In practice, its gate job logs `skip (backup-…min-ago)` and its backup job is skipped while Azure keeps its slots.
- Ideally, also a catch-up after a real missed slot.
- A merge or a green CI is not enough.

