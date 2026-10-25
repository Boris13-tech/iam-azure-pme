# Production change record

| Item | State |
|---|---|
| Rule | Every change to Production (deployment, promotion, migration, configuration, secret) has a human approval that is **explicit** (the operator, for this exact change), **traceable** (recorded outside the session that executed it, durable, tamper-evident) and **linked** (it names the commit or deployment it approves). Operator's rule of 2026-10-25: no sensitive Production action without an explicit and traceable approval |
| Started | 2026-10-25, after the audit of the deployments of that day |

## 1. Changes

| Date (UTC) | Change | Approval evidence | Executed by | Checks | Rollback target |
|---|---|---|---|---|---|
| 2026-10-25 ~19:37 | **Restore**: `vercel promote` of `dpl_FYCwHofrHqPunQ6L9jZa5ZKxDWbH` (commit `d631edb`), after the [2026-10-24 incident](../incidents/2026-10-24-PRODUCTION-DOMAIN-OVERWRITTEN.md) | The operator's answer "GO, restaure maintenant", **19:36:16.787Z**, in the agent's session log (record `f4f2eec5-042c-4725-959c-4d9a795d6935`, SHA-256 of the record `4aafa618…bb1ae`); a verbatim copy and its hash are in the operator's private evidence store (`approvals/2026-10-25/`) | Claude (agent), with the operator's Vercel command-line credentials | Read-only: `/login`, `/signup`, `/login/recovery`, `/invitation` 200; `/`, `/dashboard` redirect to `/login`; API 401 | The intruding deployment (not to be restored) |
| 2026-10-25 20:56:51 | **Deploy** commit `464c26541df0f62b2f0b290446924837007e22bd` (security patches: next 15.5.28, zod 4.6.6), deployment `dpl_Fd1NttL6FHumdR9THjwkeR3wkRR8`; no migration (all already applied, read-only check) | The operator's answer "GO, déploie 464c265", **20:54:16.008Z**, 2 min 35 s before the deployment was created (record `f647fc87-9f35-47ec-bfe8-6fee7ed4110c`, SHA-256 `10531278…3d018`), same storage as above | Claude (agent), Vercel API `gitSource` with the exact SHA, the operator's Vercel command-line credentials | Read-only: same pages and API, runtime logs without error. **Open: the operator's passkey sign-in** | `dpl_FYCwHofrHqPunQ6L9jZa5ZKxDWbH` |

Earlier Production changes (F1, F2, F3, B1 to B5) were approved by the operator in the conversation of the time and are described in `docs/certification/`; they are not re-audited here.

## 2. GOV-001: approvals not traceable outside the agent's session

| Item | Finding |
|---|---|
| What | Both changes of 2026-10-25 were **explicitly approved** before they ran (evidence above). But the approval exists only in the agent's local session log on the operator's computer: not tamper-evident, not visible to a reviewer, not linked to the Vercel deployment, and the approver's identity is the computer's session, not an authenticated step. The deployments ran with the operator's personal Vercel credentials, so Vercel records them as the operator's own actions |
| Severity | Medium (governance). No unauthorised change happened; the gap is that it could not be proven to a third party |
| Interim measure (in place) | Each approval is copied verbatim with its SHA-256 into the private evidence store and listed in section 1 before the change is reported done |
| Measure (prepared, class A, in review) | `.github/workflows/production-deploy.yml`: the only path to change Production code. Started with the exact commit; checks that it is on `main` with a green CI run; the deploy job waits in the GitHub environment **Production**, whose required reviewer is the operator, so GitHub records **who approved, when, for which run and commit**; deploys through the Vercel API with a token kept only in that environment; checks Production from outside; **promotes the previous deployment back** if a check fails; writes the record (approval, commit, deployments, checks) in the run summary |
| Operator steps to activate it | Create a Vercel token for deployments and store it as the secret `VERCEL_DEPLOY_TOKEN` of the GitHub environment Production; add the variables `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` and `GITHUB_REPOSITORY_ID_FOR_VERCEL` (not secrets) to that environment; then review and merge the PR |
| Rule once active | Agents never deploy or promote from a command line again. A promotion for an emergency rollback is also run from a reviewed workflow, or by the operator in the Vercel dashboard |
| Residual | The operator's own Vercel credentials can still deploy from any computer (cause of the 2026-10-24 incident). External monitoring is what catches that (G6) |
