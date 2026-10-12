# Backup and restore: inventory, classification, policy and restore drills

Status: **P1, approved direction (2026-10-12).** The operator's required order:
1. inventory;
2. classification;
3. retention policy;
4. real restore test;
5. RTO and RPO measurement;
6. validation of recent backups;
7. identification of really redundant backups;
8. deletion proposal.

Nothing is deleted without the operator's final approval. This document covers steps 1 to 3 and prepares 4 to 7.

Goal: **we can lose the database and prove that LUXIA comes back.**

## 1. Inventory (read-only, 2026-10-12 ~20:40Z)

**Platform (VERIFIED):**
- Neon project `hidden-leaf-91460552`:
  - plan **Free** (`free_v3`);
  - region `aws-us-east-1`, PostgreSQL 17;
  - **point-in-time history: 6 hours** (`history_retention_seconds` = 21600);
  - compute fixed at 0.25 CU;
  - **10 of 10 branches used.**
- Application: Vercel team plan **Hobby**, functions in `iad1` (US East).

**Branches** (all in the same project, copy-on-write children of `main`):

| Branch | Name | State as of | Expires | Class |
|---|---|---|---|---|
| `br-billowing-frog-ahtirmax` | `main` | live | never | **A** Production |
| `br-snowy-dawn-ahbgmqhr` | backup-pre-b4-break-glass-20261012 | 2026-10-12 18:50Z | 2026-10-26 | **B** rollback point |
| `br-dawn-scene-ahdunopo` | backup-pre-b2-recovery-20261012 | 2026-10-12 07:02Z | 2026-10-26 | **B** |
| `br-cold-bread-ah1hlohl` | backup-pre-b3-session-resolve-20261011 | 2026-10-11 20:26Z | 2026-10-25 | **B** |
| `br-twilight-wildflower-ah68mp0p` | backup-pre-status-scope-20261011 | 2026-10-11 17:16Z | 2026-10-25 | **B** |
| `br-plain-union-ah2o23ll` | backup-pre-self-onboarding-20261011 | 2026-10-11 01:24Z | 2026-10-25 | **B** |
| `br-misty-scene-ahhdjk9z` | backup-pr14-production-20261008 | 2026-10-08 03:37Z | **2026-10-15** | **B** |
| `br-icy-darkness-aho1v83p` | archive-lab-pre-neutralization-20261011-1350 | 2026-10-11 13:50Z | 2026-11-10 | **C** evidence archive (operator decision) |
| `br-noisy-forest-ahmc8gdq` | pre-production-activation-d5292c3 | 2026-09-24 01:56Z | **never** | **D** historical, purpose not recorded |
| `br-tiny-math-ah0c8uyn` | prod-backup-pre-canonical-admin-v1-20261002 | 2026-10-02 03:15Z | **never** | **D** |

Classes:
- **A**, the live database;
- **B**, a rollback point taken before a Production change;
- **C**, an evidence archive with a named purpose and end date;
- **D**, a snapshot with no expiry and no recorded purpose.

## 2. Findings

| # | Finding | Evidence | Why it matters |
|---|---|---|---|
| F1 | **No independent backup.** Every backup is a branch of the same project, in the same account, provider and region, sharing storage with `main` | Inventory | The loss of the project or the account, an account compromise or a provider incident loses every backup at once. Today we **cannot** prove that LUXIA comes back after losing the database |
| F2 | Point-in-time restore covers only 6 hours | `history_retention_seconds` | Corruption noticed after 6 hours can only go back to the latest rollback point. Data loss could be days |
| F3 | No restore has ever been tested end to end (restore, then the application running on it) | No drill on record | RTO and RPO are unknown |
| F4 | The branch quota is full | 10/10 | Clone rehearsals, our main safety practice before migrations, are blocked. Branch-per-change does not scale |
| F5 | Free and Hobby plans, US regions | Inventory | Commercial and legal, not only technical: no service commitment, data residency in the US. ASSUMPTION to confirm: Vercel's terms reserve Hobby for non-commercial use |
| F6 | Backups hold the same personal data as Production | Copies of `main` | Retention must fit the privacy policy: deleted data survives in backups until they expire |

## 3. Proposed retention policy

| Kind | Rule |
|---|---|
| Point-in-time | At least 7 days (needs a paid Neon plan: operator decision, spend) |
| Rollback point (B) | One before each Production migration. Expires 14 days after the release is certified. At most 3 at once; the oldest goes first |
| Evidence archive (C) | Only with a named purpose and an end date written in the certification report |
| Independent backup (new) | Daily logical dump (PostgreSQL custom format), encrypted with a key LUXIA holds, stored outside Neon in a region the operator chooses. Keep 30 daily and 12 monthly |
| Unlabelled (D) | Not allowed. Each existing one is classified (section 6) and either given a purpose and an end date, or proposed for deletion |
| Restore drill | Monthly, and before the private beta |

## 4. Restore drills (step 4) and measurement (step 5)

**Drill A, point-in-time restore in Neon** (data stays in Neon):
1. Take a read-only snapshot of Production (business digest per table, definitions, grants), as for every release.
2. Create a branch from `main` at that instant.
3. Measure the time until it answers.
4. Check that the digest and the definitions are identical.
5. Run the read-only checks (migrations, session resolution as `app_user`).
6. Measure the time to switch a non-Production deployment to it.
7. Delete the drill branch.

- **Needs one free branch slot.** `br-misty-scene-ahhdjk9z` expires on its own on **2026-10-15 03:37Z**. The drill can run then, with no deletion.

**Drill B, losing the Neon project** (the real disaster case):
1. Make a logical dump of Production.
2. Restore it into an empty PostgreSQL 17 outside Neon.
3. Apply the same checks.
4. Start the application against it, outside Production.

- **Needs an operator decision:** where Production data may be copied (a local Docker container on the operator machine, or an object store and region of choice). That copy is a new exposure of personal data. A PostgreSQL client in Docker is available on the operator machine.

**Measures recorded for each drill:**
- RTO: from the decision to restore until the application answers on the restored data;
- RPO: the age of the most recent data that survives;
- whether the data matches, by digest;
- every manual step, each of which becomes a runbook line.

## 5. Validation of recent backups (step 6)

For each class B branch:
- prove that it opens;
- prove that its digest matches the Production snapshot taken at the same time, when one exists (B2, B3 and B4 have them in their certification reports).

This needs a compute endpoint on each branch. The free plan limits computes, so it is done one branch at a time, after Drill A.

## 6. Redundancy analysis of class D (step 7) and deletion proposal (step 8)

For `br-noisy-forest-ahmc8gdq` (2026-09-24) and `br-tiny-math-ah0c8uyn` (2026-10-02):
- **recovery value:** compare, table by table and row by row, with the oldest class B backup that will remain. Every row must exist unchanged in the newer backup, or its later change must be explained by a recorded migration or ceremony;
- **evidence value:** check whether a certification report cites them;
- **outcome:** a proposal per branch (keep with a purpose and an end date, or delete), with the evidence, for the operator's decision. **No deletion before that decision.**

## 7. Resolving the branch quota

Options:
1. a paid Neon plan (more branches and longer history; spend);
2. the retention policy of section 3, which keeps at most 3 rollback points and no unlabelled snapshot;
3. independent backups, so class C archives no longer need to be branches.

**Recommendation:** 1 and 2 together, with 3 as part of the independent backups. Shortening or deleting any existing branch stays an operator decision.

## 8. Decisions that belong to the operator

1. Paid plans (Neon, and Vercel for commercial use), and the regions for data and backups.
2. Where the independent backups and the Drill B copy may live, and who holds the encryption key.
3. Each deletion proposed in section 6.
