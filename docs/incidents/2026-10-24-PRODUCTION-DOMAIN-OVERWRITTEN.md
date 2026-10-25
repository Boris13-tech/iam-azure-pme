# Post-incident report: the Production domain served another application

| Item | Value |
|---|---|
| Severity | **S2** (service down: sign-in impossible for every organization). No data exposure found |
| Start | 2026-10-24 09:12 UTC (deployment of another application to the LUXIA Production target) |
| Detected | 2026-10-25, by chance, during a design audit of the public pages. **No alert fired**: no application monitoring is in place yet (G6) |
| Resolved | 2026-10-25, about 19:20 UTC, by promoting the last good LUXIA deployment, with the operator's explicit approval |
| Duration | About **34 hours** |
| Report written | 2026-10-25 (standard, section 16: within 5 working days for S2) |

## What happened

1. On 2026-10-24 at 09:12 UTC, a command-line deployment (`vercel deploy --prod`, 138 static files) of an unrelated project, a support-training simulator built in another working folder on the operator's machine, was sent **to the LUXIA Vercel project** with the operator's own Vercel credentials, and became its Production deployment.
2. The domain `iam-azure-pme.vercel.app`, which is also the **passkey relying-party identifier**, then served that static site. `/` answered 200 with the other application; `/login`, `/signup` and every API path answered the platform's `404 NOT_FOUND`.
3. The other folder was later linked to its own, separate Vercel project, but the LUXIA Production target was not restored.

## Impact

| Area | Effect |
|---|---|
| Availability | Nobody could sign in, sign up or reach the API for about 34 hours. Today only the operator and test organizations use Production; no pilot customer was affected |
| Session cookies | Not readable by the foreign site: `luxia_session` is `HttpOnly`, `Secure`, `SameSite=Lax` (verified in the code). The foreign site was the operator's own static application with no server side |
| Passkeys | No new credential or assertion could be produced for LUXIA: the LUXIA server was not reachable to issue challenges. The foreign site was the operator's own code, not an attacker's. **Residual lesson:** whatever is deployed on this domain runs on the passkey origin |
| Database, backups, secrets | Not touched. Hourly backups kept succeeding (last checked 2026-10-25 18:53 UTC) |
| Personal data breach | **None found.** Temporary unavailability, no loss, no disclosure, no real customer data subjects. No notification required; recorded here |

## Resolution (verified)

- `vercel promote` of `dpl_FYCwHofrHqPunQ6L9jZa5ZKxDWbH`, the deployment of commit `d631edb` created on 2026-10-15 at 17:00 UTC, identical to the Production recorded on GitHub (17:02 UTC). Instant, no rebuild, no migration, no secret change. Operator's explicit approval, 2026-10-25.
- After-checks, read only: `/login`, `/signup`, `/login/recovery`, `/invitation` answer 200 with the LUXIA page; `/` and `/dashboard` redirect to `/login` without a session; an API path answers 401 without a session; the domain resolves to the promoted deployment.
- **Still to do:** a real passkey sign-in by the operator with their own account (the standard's real-scenario proof).

## Causes

| Level | Cause |
|---|---|
| Direct | A deployment command run from the wrong folder link, against the LUXIA project |
| Enabling | The operator's Vercel credentials can deploy any of the operator's projects from any folder on the machine. Vercel offers no setting on the free plan that limits Production deployments to one source |
| Detection | **No monitoring**: the outage was found 34 hours later, by chance. Minimum monitoring is designed (G6) but not active |

## Actions

| # | Action | Owner | State |
|---|---|---|---|
| 1 | Restore the Production deployment | Claude, with the operator's approval | **Done** |
| 2 | Operator's passkey sign-in to prove the service end to end | Operator | Open |
| 3 | **External monitoring now**: a free UptimeRobot keyword monitor on `https://iam-azure-pme.vercel.app/login` expecting the text `LUXIA`, every 5 minutes, alerting the operator by e-mail and push. It needs only an account, which the operator creates (no code). Monitoring design M-A | Operator | Open (recommended today) |
| 4 | A free Production canary in GitHub Actions (`production-canary.yml`): every 30 minutes, checks that `/login` serves LUXIA, that `/` redirects to `/login` and that an API path answers 401; a failure fails the run and GitHub e-mails the operator. A stopgap: GitHub's scheduler is irregular (E4) | Claude (PR), operator merges (CI change) | In review |
| 5 | Rule for every working session on this machine: before any `vercel deploy --prod`, check the linked project (`.vercel/project.json`) and pass the project explicitly. LUXIA itself is deployed through the API with an exact commit, never from a folder | Operator and every session | Recorded |
| 6 | Monitoring slices 1 and 2 (#102, #108), then G7 alert tests | Reviewer, operator | In the class A queue |
