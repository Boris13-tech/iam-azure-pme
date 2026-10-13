# LUXIA Identity: subprocessors

**DRAFT — LEGAL REVIEW REQUIRED.** Technical first draft (2026-10-13). The list reflects the services the code and the operations actually use.

## In use today

| Subprocessor | What it does for LUXIA | Customer data it holds or sees | Location today | Notes |
|---|---|---|---|---|
| **Neon** | Managed PostgreSQL database (Production and its branch backups) | All customer data (section 3 of `PRIVACY-POLICY.md`) | US East (`aws-us-east-1`, on AWS) | Free plan today. Target: a project in Frankfurt (`aws-eu-central-1`) on a paid plan before a commercial beta (`docs/operations/HOSTING-EU-AND-COSTS.md`) |
| **Vercel** | Hosting of the web application and its server functions | Customer data in transit through the application; request logs kept by Vercel **[TO BE CONFIRMED: content and retention of Vercel logs]** | US East (`iad1`) | Hobby plan today, which Vercel reserves for personal, non-commercial use. Pro plan and the Frankfurt functions region before a commercial beta |
| **GitHub** | Source code, continuous integration | **None.** CI uses synthetic test data in a database that is destroyed after each run | US | The operator's GitHub account |

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
| Scaleway | Encrypted independent backups (object storage with lock). Only the encrypted file is stored; the key stays with LUXIA | Paris, EU | Recommended, waiting for the operator's decision (`docs/operations/INDEPENDENT-BACKUP-ARCHITECTURE.md`) |
| An e-mail or notification provider | Invitations, security notices | EU preferred | Not chosen (`docs/architecture/NOTIFICATION-CONTRACT.md`) |
| A monitoring provider | Availability and error alerts | EU preferred | Not chosen |

## Changes

LUXIA tells its customers before adding or replacing a subprocessor that processes customer data. The notice period is **[TO BE COMPLETED]**, and the customer may object as the DPA sets out.
