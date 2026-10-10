# LUXIA Identity — CURRENT STATE

Snapshot: 2026-10-10 ~11:30Z, written by Claude Code after the PR #16 merge, the Production deployment of the merge SHA, and the read-only Production preflight.
The repository is the source of truth. No agent may rely on another agent's memory.

Evidence labels:

- **VERIFIED 2026-10-10**: observed directly in this snapshot (GitHub API, CI, Vercel API, HTTP, git objects, source review, or the read-only preflight run by the operator).
- **VERIFIED FROM PRIOR CERTIFICATION EVIDENCE**: taken from committed `docs/certification/*` files. **Not** re-executed in this snapshot.
- **OPERATOR-REPORTED 2026-10-10**: performed and reported by the human operator in chat; not independently observed by the agent.
- **PENDING**: not yet observed.

## 1. Branches, SHAs, deployment

| Item | Value | Evidence |
|---|---|---|
| `main` | `8acea18fae902aad1d444db3b21eef721b4e0760` (merge of PR #16, 2026-10-10T10:39:37Z) | VERIFIED 2026-10-10 |
| CI on `main` @ 8acea18 | `test-and-build` PASS: https://github.com/Boris13-tech/iam-azure-pme/actions/runs/38045671666 | VERIFIED 2026-10-10 |
| Production deployment | `dpl_J3GnuWwpMFejURjG5ASKWc8nJK5U`, target production, **READY**, `githubCommitSha` = `8acea18fae902aad1d444db3b21eef721b4e0760`. It is the current Production target of Vercel project `prj_dZ6YOYRdONsicgWdlmofh7NwtoSP`, aliased to https://iam-azure-pme.vercel.app. | VERIFIED 2026-10-10 (Vercel API) |
| How it was deployed | Vercel API `POST /v13/deployments` with `gitSource` = GitHub repo 1270644438, ref `main`, exact sha. Built by Vercel from GitHub; no local upload, no env change, no migration (build = `tsc`, lint, `prisma generate`, `next build`). | VERIFIED 2026-10-10 |
| Rollback deployment | `dpl_DUEzcvKxUvN1wxox67sxnQdSvfpW` (`e4038f8`, READY) | VERIFIED 2026-10-10 |
| Auto-deploy from `main` | **Disabled by design** (`vercel.json`: `git.deploymentEnabled.main = false`). Production deploys are manual operator actions. | VERIFIED 2026-10-10 |
| Application code `e4038f8` → `8acea18` | Identical. PR16 changed only `scripts/`, `tests/`, `docs/` and `.gitignore`. | VERIFIED 2026-10-10 (git diff) |

## 2. Pull requests

| PR | Head SHA | Status | Evidence |
|---|---|---|---|
| #16 Operator-only canonical browser evidence transport | `12e5eebb463ddf2f25a8990ca54d38f4d4ed6dfc` | **MERGED** as `8acea18` with explicit human authorization. Head CI PASS (run 38045374460). | VERIFIED 2026-10-10 |
| #17 docs(handoff) | this PR | Draft, docs only | VERIFIED 2026-10-10 |
| #12 Providers Management v1 (`feat/providers-management-v1`) | `d604a48fa62fbec65676c0423a08645805d67129` | Draft. CI PASS on its own head. **Merge state CONFLICTING** with `main` (`app/dashboard/layout.tsx`). Based on old `main` `4b0d228` (before PR13). | VERIFIED 2026-10-10 |

Merged before PR16: #1–#11, #13 (Resources & Governance v1), #14 (Resource Access Onboarding v1), #15 (operator runner + release binding). VERIFIED 2026-10-10.

## 3. Authoritative Production constants

These are also hard-coded in `scripts/operators/resource-owner-bootstrap.ts`.

- Organization `4841428a-80b4-4f07-bb3f-c94612dfd4a2` (Legrand Tech); Tenant `c68ae9ee-11a8-42f9-bc9c-b19c42ec7914`
- Canonical Subject `30a15eda-24d3-40ef-8705-11c2e6e1b929`
- Entra: user OID `e6ac473c-0e9a-4d04-bd02-4954b3caa6d2`, client ID `811dde0e-7a03-4e10-9bfc-9f24efdb972b`, Entra tenant `b8f6e875-25cd-4d75-90ec-e6dd206057e5`
- Resource `ed8c9111-a930-4724-a76d-bd541538a621` (LUXIA Internal Resource Test, API)
- Scope `3952f920-c064-46a2-9d22-d31d338c8a54` (RESOURCE)
- Entitlement `d6605f22-64f1-467b-b4e4-de806d2c957c`, action `resource.read`
- Neon project `hidden-leaf-91460552`; Production branch `br-billowing-frog-ahtirmax`; Vercel project `prj_dZ6YOYRdONsicgWdlmofh7NwtoSP`
- Certification clone used by PR16: `br-misty-sun-ahs4b46j`. The previous clone `br-crimson-credit-ahqddpia` was archived.

Never reuse superseded or typo values.

## 4. Production state: read-only preflight

Run by the operator on 2026-10-10 at **11:25:58Z**. The script was `scripts/operators/production-resource-preflight.ts` @ `8acea18`, with `app_user` on the Production pooler endpoint inside a `READ ONLY` transaction. Verdict: **PASS**. VERIFIED 2026-10-10.

| Check | Result |
|---|---|
| Endpoint = Production `app_user`, `neondb`, `sslmode=require` | true |
| `app_user` NOSUPERUSER / NOBYPASSRLS / owns no tables | true / true / true |
| RLS enabled + forced on all 12 controlled tables | true |
| No PUBLIC EXECUTE on `luxia_*` functions, and no default PUBLIC EXECUTE | true |
| Subject ACTIVE | true |
| Exact Resource / RESOURCE Scope / Entitlement binding | true |
| SoD for the target grant | no conflict (ALLOW) |
| **Bootstrap Assignment count on the target entitlement** | **0** |
| Protected capability decision | **DENY** |
| Mutations | NONE |
| Migrations applied | 19 |
| Sessions | 68 total, 1 unexpired (59 on 2026-10-09; increase = logins) |

Data preservation compared with the last baseline (`PR15-RELEASE-BINDING-RECERTIFICATION-2026-10-09.md`, 2026-10-09T06:23:54Z):

| Table | Count | Digest | vs. 2026-10-09 |
|---|---|---|---|
| Assignment | 21 | `83e7540cab85667c96e63da4ba5f2183` | **identical** |
| IdentityAccount | 2 | `0714d38589d2ee4dc18a4da0bf7c98a0` | identical |
| Subject | 1 | `457b5d60f12a6dfcefe1712016502d82` | count identical |
| Resource / ResourceScope | 1 / 1 | `6b36638b…` / `d97dbb74…` | count identical |
| Entitlement | 22 | `ba34b454b1fbe0bbc37518a324d6d95c` | — |
| ProviderConnection | 2 | `5f02e7ab268625a8886d5c098f4f7998` | count identical |
| Legacy User / Role / UserRole / Permission / LegacyUserBridge | 2 / 3 / 2 / 0 / 0 | — | count identical |

`PRODUCTION_REGISTRATIONS` (runner registry) is empty. No Production first-owner grant has ever been executed (VERIFIED FROM PRIOR CERTIFICATION EVIDENCE: `PR15-MANIFEST-EXPIRY-2026-10-09.md`, `PR14-BOOTSTRAP-ABANDONED-2026-10-08.md`; consistent with the Assignment digest above).

## 5. Abandoned artifacts (never reuse, extend or re-timestamp)

- Manifest binding `95e9b80de3e28890faf01eb41fb70002d6ef1efb6986815da8b8868799376232`, with assignment `d19ec5fa-…` and operation `6bb7d556-…`. These are hard-coded as forbidden in the runner.
- Manifest binding `2f11099801881d9109a8c5c8b313643a4762b93d8169f675307c24ac48041a89`, with assignment `f5faba6f-7b29-4704-94b4-608001827597` and operation `cd2ac2e0-a103-4ad1-8125-5f59957afbfb`. It expired 2026-10-09T12:18Z and its detached approval is void.

## 6. Completed certifications

| Certification | Evidence |
|---|---|
| Identity baseline (Organization/Tenant, forced RLS, Subject, IdentityAccount, Entra, LUXIA_LOCAL/passkeys, sessions, JML, canonical audit) | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE |
| Resources & Governance v1, SoD v1, Access Reviews v1, SQL function privilege hardening | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (`PR13-*`, `SOD-V1-*`, `ACCESS-REVIEWS-V1-*`) |
| Resource Access Onboarding v1 application layer (pre-bootstrap) | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (`RESOURCE-ONBOARDING-PREBOOTSTRAP-2026-10-08.md`) |
| Operator runner on clone: DENY → one bounded DIRECT grant → ALLOW → replay → revoke → DENY → no recreation | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (`PR15-RELEASE-BINDING-RECERTIFICATION-2026-10-09.md`) |
| PR16 browser-evidence transport on clone (ci05): 367 passed, 0 failed; no deadlock, open transaction or advisory lock | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (`OPERATOR-BROWSER-TRANSPORT-2026-10-09.md`) |
| PR16 static security review | VERIFIED 2026-10-10 |
| PR16 merge-SHA CI + exact-SHA Production deployment | VERIFIED 2026-10-10 |
| Production unauthenticated HTTP smoke on `8acea18`: `/login` 200; `/dashboard` 307 → `/login`; `/api/resources/protected-resource-demo` 401 `{"error":"Unauthorized"}` | VERIFIED 2026-10-10 |
| Production read-only DB preflight (section 4) | VERIFIED 2026-10-10 |
| Production authenticated smoke on `8acea18`: (1) Entra login reaches the dashboard; (2) `/dashboard/users`, `/dashboard/resources`, `/dashboard/governance/sod`, `/dashboard/governance/access-reviews` and `/dashboard/resources/onboarding` render; (3) the authenticated protected route returns 403 `RESOURCE_ACCESS_DENIED` with an `evidenceId`; (4) sign-out, then LUXIA_LOCAL passkey login reaches the dashboard. **All 4 OK.** | OPERATOR-REPORTED 2026-10-10 |

## 7. Pending certifications

- **Resource Access Onboarding v1 Production end-to-end**: NOT EXECUTED. No Production grant has ever run.
- PR12 live provider certification: Entra BLOCKED (dedicated credentials/consent missing), Google BLOCKED (same), OIDC BLOCKED (no approved issuer).

## 8. Security invariants (non-negotiable)

- Default deny and tenant isolation, with PostgreSQL RLS enabled and forced on controlled tables.
- `app_user` is NOSUPERUSER and NOBYPASSRLS, owns no controlled table, and there is no PUBLIC EXECUTE on LUXIA functions. These were re-observed in Production on 2026-10-10 (section 4).
- No secret, token or DB URL in logs. No silent grant, no implicit first owner, and `resources.manage` never implies Resource access.
- The browser never controls Subject, Resource, action or grant. There is no legacy Role authority.
- No cross-tenant enumeration. Every privileged operation is audited, replay-protected, idempotent and fails closed.
- The first owner is created only by an explicit operator ceremony with a detached human approval.

## 9. Operator tooling state (operator workstation, not the repo)

- Neon CLI `neon` 8.3.5 is installed, and the operator is signed in.
- The Neon MCP server is configured for Claude Code (user scope) with OAuth, **read-only**, and pinned to `hidden-leaf-91460552`.
- The Neon skills `neon` and `neon-postgres` are installed at user level.
- The Vercel CLI is signed in to scope `legrandborisohandjaedimo-4025s-projects`.
- The operator's git `user.email` is misconfigured as `…@gmailcom` (missing dot); historical commits carry it.

## 10. Known limitations

- The Production runner is specific to the operator's Windows machine: it resolves the Vercel CLI through `%APPDATA%`.
- Browser evidence is bound to its probe by time only: the event must be fresh after the probe starts. The server event does not carry the probeId. Fixed actor/tenant/resource/action/assignment checks and a consumed-ID set mitigate this.
- Evidence freshness compares the app server's `occurredAt` with the operator's local clock, with no lower-bound tolerance. Clock skew fails closed.
- In the runner, the modified-replay check is a local `validate()` refusal. The ceremony-level modified-bytes refusal is covered by clone tests.
- **Repo hygiene issue:** a tracked file named `" README.md"` (leading space) breaks a plain checkout on Windows. Workaround: `git config core.longpaths true` plus a sparse-checkout excluding `/ README.md`. A separate fix is proposed (rename or remove).
- Windows operators must run operator shell scripts through Git Bash (`C:\Program Files\Git\bin\bash.exe`). In PowerShell, `bash` resolves to the WSL launcher.
- PR12 must be rebased onto current `main` before any review.

## 11. Blockers / next gates

1. Operator authenticated browser smoke: DONE (OPERATOR-REPORTED 2026-10-10, all 4 steps OK).
2. New manifest: requires explicit human approval to generate. Generate it only at the start of a ceremony session (validity window ≤ 1 h), with new assignmentId/operationId/validFrom, validUntil ≤ 1 h and a new binding, revalidated against section 4. Then **STOP for explicit human approval**.
3. Production ceremony: only after explicit approval of that new manifest.
4. PR12: live provider credentials/consent/issuer, and a rebase.
