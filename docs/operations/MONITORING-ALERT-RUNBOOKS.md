# Runbooks for the monitoring alerts

| Item | Value |
|---|---|
| Purpose | One runbook per alert of the [minimum monitoring design](MINIMUM-APPLICATION-MONITORING-DESIGN.md) (M-A to M-F) and of the retention job (R3), in the [template](../engineering/templates/INCIDENT-RUNBOOK-TEMPLATE.md) form. Standard, section 16: every S1 and S2 scenario has a runbook, exercised each quarter |
| Status | **Written 2026-10-23, not yet exercised.** The signals depend on #102 (M-A, M-B), #108 (M-C), monitoring slices 3 (M-D) and 4 (M-E), and #127 (R3). The backup freshness alert in Azure already exists ([backup runbook](BACKUP-RUNBOOK.md), section 2) |
| Owner | The operator (one person, no on-call rotation: the response targets of the standard are not guaranteed) |
| Rule for every step | Read only first (`READ ONLY` transactions in Production). Every Production write goes through its gate. Never paste a secret, token, connection string or recovery code into a ticket, a chat or a log |

Severity at a glance:

| Alert | Severity | Typical first action |
|---|---|---|
| M-A liveness down | S2 | Is it the platform or our deployment? Roll back the deployment if ours |
| M-B database not ready | S2 | Neon status and quota; never fall back to another connection |
| M-C error burst, or `component=session` burst | S3, or **S2** for session | Read the scrubbed event; roll back if a deployment caused it |
| M-D sign-in system failures | S2 | Which method and which system reason; the provider or our code |
| M-E backup heartbeat missing | S2 | Backup runbook, section 2 |
| R3 retention job failed or silent | S3 | Read the code in the log; rerun the next day |
| Any sign of exposure across organizations | **S1** | [Tenant isolation incident](LUXIA-IDENTITY-V1-RUNBOOKS.md#tenant-isolation-incident) and the [incident response](../legal/INCIDENT-RESPONSE-AND-BREACH-NOTIFICATION.md) |

## 1. M-A: liveness down (S2)

**Detection.** The external probe of `GET /api/health` or `GET /login` failed twice in a row. Both are answered by the application runtime, with no database access.

**Immediate safety (15 minutes).**
1. Open the hosting platform's status page and the project's deployment list. Was a deployment made in the last hours?
2. If our deployment caused it: **roll back** by redeploying the recorded previous deployment (rollback rule; no data change). This is a Production deployment: the operator does it.
3. If the platform is down: nothing to roll back. Post nothing publicly; note the times.

**Diagnosis.** Runtime logs of the failing deployment (error codes only). The domain and its certificate. The region (Frankfurt after EU-4).

**Recovery and verification.** Both probes green for 15 minutes. A real passkey sign-in with the operator's own account.

**Communication.** Pilot security contacts, if the outage lasts more than 1 hour during their working hours: what is down, since when, next update. No promise of a recovery time (pilot agreement, section 7).

**Closure.** Post-incident report within 5 working days (S2).

## 2. M-B: database not ready (S2)

**Detection.** `GET /api/internal/readiness` (with the monitoring token) answered 503 twice, at the hourly probe.

**Immediate safety.**
1. Neon console: is the compute suspended, the project over its monthly compute quota (Neon Free: 100 compute-hours; the database is suspended until the next month), or Neon down?
2. **Never** point the application at another connection, an owner role or a role that bypasses row-level security to "get it working". The runtime role stays `app_user`.

**Diagnosis.** Neon status; the compute-hours used this month; recent migrations; the readiness error is generic by design, so use the Neon console and the platform logs.

**Recovery.**
- Quota exhausted: the only immediate fix is a paid plan (a budget decision for the operator) or waiting for the next month. Record it as a budget incident.
- Neon outage: wait; if the outage threatens the data, follow [Backup restore](BACKUP-RUNBOOK.md) (section 3), which restores into a new database.

**Verification.** Readiness 200; a sign-in; the next backup verified.

**Communication and closure.** As M-A.

## 3. M-C: error burst, and SLI-03 (S3, or S2 for sessions)

**Detection.** A new issue in the error tracker; more than 5 errors in 5 minutes; or 3 errors tagged `component=session` in 5 minutes (sessions failing: people are being signed out or refused).

**Immediate safety.**
1. Open the event. It is scrubbed: no headers, cookies, query strings, bodies or user fields. Do not try to recover them from elsewhere.
2. If the errors started with a deployment: roll back (as M-A).
3. A session-resolution burst that could mean sessions are accepted when they should not be (not refused when they should be): treat as **S1** and follow the tenant isolation runbook.

**Diagnosis.** The error code and the route; the commit; whether one organization or all are affected (from the route, not from personal data).

**Recovery and verification.** No new event for 30 minutes; the session suite (`tests/security/session-*.test.ts`) green on the fix's commit.

**Closure.** S2: report within 5 working days. S3: fix planned within 7 days.

## 4. M-D: sign-in system failures (S2)

**Detection.** The aggregate endpoint reports at least one sign-in failure with a **system** reason (database, provider, internal) in the last 15 minutes. User errors (wrong passkey, cancelled ceremony) never alert.

**Immediate safety.**
1. Which method: passkey or Microsoft Entra? Which reason?
2. Database reason: go to M-B. Provider reason: the [provider outage](LUXIA-IDENTITY-V1-RUNBOOKS.md#provider-outage) runbook; passkeys and recovery codes keep working.
3. Internal reason after a deployment: roll back.

**Recovery and verification.** Zero system failures over 15 minutes; a real sign-in with the operator's account for the failing method.

**Communication and closure.** As M-A.

## 5. M-E: backup heartbeat missing (S2)

**Detection.** No ping from a verified backup run for 3 hours, at the second watcher outside Azure. The Azure freshness alert (`luxia-backup-freshness`) normally fires too.

**Immediate safety and recovery.** [Backup runbook](BACKUP-RUNBOOK.md), section 2 ("Watching it, and catching up"): find the failed run, fix its cause, run a backup by hand, verify it. Until a backup is verified, **no Production migration or deployment** (standard, section 10: a fresh verified backup is a precondition).

**Verification.** A new verified backup; both watchers green.

**Closure.** Report within 5 working days.

## 6. R3: retention job failed or silent (S3)

**Detection.** The daily call to `/api/internal/retention` returned 500 (the log line carries a `RETENTION_*` code only), or no `RetentionRun` row for 3 days (heartbeat, monitoring slice 4).

**Diagnosis by code.**

| Code | Meaning | Action |
|---|---|---|
| `RETENTION_ALREADY_RUNNING` | Two calls overlapped | None; the next run continues |
| `RETENTION_OWNER_REQUIRES_BYPASSRLS` | The function's owner cannot see every row | Configuration fault: the migration ran under the wrong role. Stop and review; do not grant bypass to the runtime |
| `RETENTION_ARGUMENT_OUT_OF_RANGE` | Code fault | Fix in a reviewed change |
| No row for 3 days, no error | The cron did not call: missing `CRON_SECRET`, plan change, or the cron removed | Check the platform's cron page and the environment variable (names only) |

**Recovery and verification.** The next run records its counts. Nothing urgent: a missed day only delays the purge by a day.

## 7. M-F: a missed monthly alert drill (S3)

Run the drill of the [monitoring design](MINIMUM-APPLICATION-MONITORING-DESIGN.md), section 4, for every signal, and record fired, received and acknowledged times as sealed evidence. G7 needs it current.

## Exercises

| Runbook | Last exercised | Next |
|---|---|---|
| 1 to 7 | Never | One tabletop of 1, 2 and 5 before the first pilot; then each quarter |
