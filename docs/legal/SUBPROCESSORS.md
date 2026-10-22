# LUXIA Identity: subprocessors

**DRAFT — LEGAL REVIEW REQUIRED.** Technical first draft (2026-10-13). The list reflects the services the code and the operations actually use.

## In use today

| Subprocessor | What it does for LUXIA | Customer data it holds or sees | Location today | Notes |
|---|---|---|---|---|
| **Neon** | Managed PostgreSQL database (Production and its branch backups) | All customer data (section 3 of `PRIVACY-POLICY.md`) | US East (`aws-us-east-1`, on AWS) | Free plan today. Target: a project in Frankfurt (`aws-eu-central-1`) on a paid plan before a commercial beta (`docs/operations/HOSTING-EU-AND-COSTS.md`) |
| **Vercel** | Hosting of the web application and its server functions | Customer data in transit through the application; request logs kept by Vercel **[TO BE CONFIRMED: content and retention of Vercel logs]** | US East (`iad1`) | Hobby plan today, which Vercel reserves for personal, non-commercial use. Pro plan and the Frankfurt functions region before a commercial beta |
| **Microsoft Azure** (Blob Storage) | Independent backups of the database, every 2 hours, kept 30 days | **Encrypted files only.** They are encrypted before they leave the backup job, with a key that only LUXIA holds; Microsoft never has the key | France Central (Paris), EU, 3 zones | Since 2026-10-13, the operator's own Azure subscription. Deletion refused during the retention period (`docs/operations/INDEPENDENT-BACKUP-ARCHITECTURE.md`) |
| **GitHub** | Source code, continuous integration, and the backup job (GitHub Actions) | CI: **none**, synthetic test data in a database destroyed after each run. Backup job: the database passes through the job's temporary machine **only to be encrypted**; only ciphertext is written to disk, and the machine is discarded after each run | US | The operator's GitHub account |

## Used only by organizations that choose them

| Service | Role | Note |
|---|---|---|
| **Microsoft Entra ID** | Sign-in for organizations that connect their own Microsoft tenant | The organization's own provider, chosen by the organization. Whether Microsoft is a LUXIA subprocessor or the customer's own processor: **[TO BE DECIDED by counsel]** |

## Tools of the LUXIA operator that can reach Production

**[TO BE DECIDED by counsel: whether to list them here]**

- **AI engineering assistant (Anthropic, Claude), used by the operator.** It runs read-only checks of Production from the operator's workstation, under the operator's supervision. Its outputs are restricted to counts, statuses and hashes, without personal data. Any write follows an approved, journaled procedure.
- **The operator's workstation** holds the Production connection credentials. It is not a backup destination.

## Planned (not in use)

| Subprocessor | For | Location | Status |
|---|---|---|---|
| Scaleway | A second copy of the encrypted backups, under EU company law | Paris, EU | Recommended later (`docs/operations/INDEPENDENT-BACKUP-ARCHITECTURE.md`) |
| An e-mail or notification provider | Invitations, security notices | EU preferred | Not chosen (`docs/architecture/NOTIFICATION-CONTRACT.md`) |
| A monitoring provider | Availability and error alerts | EU preferred | Not chosen |

## Transfer facts (consulted 2026-10-18, to confirm at signature)

These facts come from each provider's own pages, consulted on 2026-10-18. Before any signature, confirm each certification on the official list (dataprivacyframework.gov) and in the provider's current data processing addendum. Counsel chooses the transfer mechanism once the entity's country and the pilots' location are known.

| Provider | Entity | Transfer basis it states | Data processing addendum | Note |
|---|---|---|---|---|
| Vercel | US company | Certified under the EU–US Data Privacy Framework; also standard contractual clauses | vercel.com/legal/dpa | Functions move to Frankfurt (`fra1`) with the EU switch |
| Neon | US company (Databricks group) | States that it relies on the EU–US Data Privacy Framework (its own listing not yet confirmed) | neon.com/dpa; subprocessors at neon.com/subprocessors, changes announced 30 days before | Production moves to Frankfurt |
| Microsoft (Azure, Entra) | US company | Microsoft's data protection addendum (certification to confirm) | Microsoft Products and Services DPA | Backups in France Central, encrypted with LUXIA's key |
| GitHub | US company (Microsoft) | To confirm | GitHub DPA | CI holds no customer data |
| Sentry (planned, monitoring option Z) | US company, EU representative in the Netherlands | Self-certified under the EU–US Data Privacy Framework | Click-through DPA | **EU data region** to be chosen at setup; events are scrubbed by LUXIA before they leave |
| UptimeRobot (planned, monitoring option Z) | **EU company** (Slovakia) | No transfer outside the EU for the provider itself | DPA version 2.0 (April 2026); countersigned copy through sales | Probes public pages and protected health answers only: no personal data |

**Legal context (2026-10-18):** the EU–US Data Privacy Framework stands. The General Court upheld the Commission's adequacy decision on 3 September 2025. An appeal is pending before the Court of Justice (C-703/25 P). If the decision falls, transfers to US providers fall back on standard contractual clauses and a transfer impact assessment.

## Changes

LUXIA tells its customers before adding or replacing a subprocessor that processes customer data. The notice period is **[TO BE COMPLETED]**, and the customer may object as the DPA sets out.
