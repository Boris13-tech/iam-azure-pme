# LUXIA Identity: security overview

**DRAFT — LEGAL REVIEW REQUIRED** before it is given to customers. Technical first draft (2026-10-13).

Every measure below is in Production and was verified, unless it is marked « not in place » or « planned ». The evidence is the certification reports in `docs/certification/`. **LUXIA holds no security certification and has had no external audit or penetration test.**

## Isolation between organizations

- Each organization's data is separated by **forced row-level security** in PostgreSQL.
- The application's database role cannot bypass it: `app_user` is NOSUPERUSER and NOBYPASSRLS.
- Isolation was certified across several organizations in Production.

## Sign-in

- **Phishing-resistant passkeys** (WebAuthn) for LUXIA local accounts.
- No passwords.
- Microsoft Entra ID for organizations that connect it. LUXIA records these sign-ins as attested by Microsoft, and does not claim multi-factor authentication it cannot prove.
- **Recovery codes:**
  - 10 per batch, shown once, stored only as hashes, single use;
  - a recovery sign-in opens a 15-minute session that can only add a new passkey.
- Session tokens are stored only as hashes.
- Sessions expire after 24 hours and can be revoked by the person or by an administrator.
- A suspended or closed organization cannot sign in, and answers like an unknown one.

## Administration

- **Least privilege:** explicit rights, separation-of-duties rules, access reviews.
- **No organization can lose its last administrator.** This is enforced in the database, including under concurrent changes.

## LUXIA operator interventions

- **The operator holds no right in any customer organization.**
- Emergency actions use a **closed list** of actions with:
  - a dry run;
  - a plan digest;
  - typed confirmation for irreversible actions;
  - an approved reference (customer request verified by two methods, or a LUXIA incident).
- Every intervention is written to the organization's journal, authored by a dedicated, disabled operator identity, and shown to the organization's administrators as « Action opérateur LUXIA ».

## Audit trail

- The administration journal and the sign-in records are **append-only**. Since 2026-10-13, the application cannot update or delete them, and neither can ordinary statements of the operator's database role.
- **This is not cryptographic immutability:** a privileged database owner could still change the guard through a reviewed migration. Verifiable, tamper-evident records are planned (LUXIA Trust Ledger).

## Data protection

- **In transit:** TLS between browsers and the application, and between the application and the database.
- **At rest:** encryption by the database provider (Neon) **[TO BE CONFIRMED with the provider's documentation]**.
- **Secrets:** never written to logs or to the repository.

## Backups and recovery of the platform

- **In place:**
  - 6 hours of point-in-time history at the database provider;
  - rollback points taken before each release;
  - **independent, encrypted backups every 6 hours** (since 2026-10-13), outside the database provider, in the European Union. They are encrypted before they leave the backup job, with a key that only LUXIA holds, and protected against deletion for 30 days. The backup role can read but never change data;
  - **a tested full restore:** on 2026-10-13 the database was rebuilt from such a backup into an empty environment. Every table and schema object matched; RPO 2 min 7 s, database recovered and verified in 81 s (`docs/certification/E1-BACKUP-RESTORE-DRILL-B-2026-10-13.md`).
- **Not in place yet:** rehearsing the switch of the application to a restored database, and an automatic alert if a backup is missing.

## Monitoring and incident response

- **Not in place:** automated monitoring and alerting. Planned before the beta.
- Incident procedure: `INCIDENT-RESPONSE-AND-BREACH-NOTIFICATION.md` (draft).

## Change management

- Every change goes through:
  - a pull request with automated tests (including PostgreSQL row-level security and database rule tests);
  - deployment of an exact, tested version;
  - for database migrations, a rehearsal and a written rollback;
  - a read-only verification in Production, recorded in a certification report.

## Hosting

- Today: United States (Neon, Vercel).
- Target before the commercial beta: European Union, Frankfurt.

See `DATA-RESIDENCY.md`.
