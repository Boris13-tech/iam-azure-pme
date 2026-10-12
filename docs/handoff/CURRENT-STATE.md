# LUXIA Identity — CURRENT STATE

> **2026-10-12 ~19:35Z — B4 OPERATOR BREAK-GLASS PROCEDURE: PRODUCTION RELEASE PASS** (`docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-B4-RELEASE-2026-10-12.md`).
> - `main` is `41d7220` (PR #50, journal-time fix, after PR #49 `2414ec6`). Production = **`dpl_3Jm2usCcwnM4JZndgAU9A7ngkfnT` @ `2414ec6`**; rollback = `dpl_CiB2VuvFtru15AxNJfa5NfDF8q2F` @ `fe34cf7`. PR #50 changes only the operator module, which the application never imports, so it is not deployed.
> - **24 migrations** in Production; the last one, `20261012180000_break_glass_operator_invitation`, was applied 18:52:31–40Z. Rollback script: `docs/operations/B4-BREAK-GLASS-ROLLBACK.sql`.
> - First Admin / Break-glass v1 status: **B1 PASS → migration PASS → B3 PASS → B2 PASS → B4 PASS**; next is **B5**, design first.
> - Operator actions on an organization go only through `scripts/operators/break-glass.ts` (dry run, digest, apply, journal event by « Opérateur LUXIA (break-glass) »). Runbook: `docs/operations/B4-BREAK-GLASS-RUNBOOK.md`.
> - `luxia-certification-lab` **CLOSED** at 19:13:29Z and `luxia-cert-b2-r6` **CLOSED** at 19:32:00Z, through the procedure, with all history kept. Legrand Tech was unchanged by both.
> - Neon backups:
>   - `br-snowy-dawn-ahbgmqhr` (before B4) and `br-dawn-scene-ahdunopo` (before B2), both until 2026-10-26;
>   - `br-cold-bread-ah1hlohl` (before B3) and `br-twilight-wildflower-ah68mp0p` (before status and scope), both until 2026-10-25;
>   - the Lab archive `br-icy-darkness-aho1v83p`: B4 is certified, so it is deleted on the operator's confirmation.
>
> This header supersedes older deployment rows below.

> **2026-10-12 ~15:20Z — B2 RECOVERY CODES AND RECOVERY-ONLY SESSION: PRODUCTION RELEASE PASS** (`docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-B2-RELEASE-2026-10-12.md`).
> - `main` is `fe34cf7` (PR #46, merged pinned on `db9f740`). Production = **`dpl_CiB2VuvFtru15AxNJfa5NfDF8q2F` @ `fe34cf7`**; rollback = `dpl_8YEyT71Z1o3CUfb8qSCTZ9V1dr6o` @ `8aec711`.
> - **23 migrations** in Production; the last one, `20261012090000_recovery_codes_b2`, was applied 07:03:35–46Z. Rollback script: `docs/operations/B2-RECOVERY-CODES-ROLLBACK.sql`.
> - First Admin / Break-glass v1 status: **B1 PASS → migration PASS → B3 PASS → B2 PASS**; next is **B4**, design only, before any code.
> - Sessions resolve only through `luxia_session_resolve`. `getSession` accepts FULL sessions only; a RECOVERY session (15 minutes) is read only by the B2 allow-list: passkey enrolment of its own account and `/recovery`.
> - R6 ran on the dedicated test organization `luxia-cert-b2-r6`, now **SUSPENDED** (15:18:29Z, B3 primitive, nothing deleted). Its final closure belongs to B4. Legrand Tech and the Lab were unchanged throughout.
> - Not independently observed in Production: the browser refusal of `/dashboard` and `/api/me/sessions` during the recovery session. It is covered by CI and the clone certification, and no security failure was observed.
> - Neon backups:
>   - `br-dawn-scene-ahdunopo` (before B2, until 2026-10-26);
>   - `br-cold-bread-ah1hlohl` (before B3) and `br-twilight-wildflower-ah68mp0p` (before status and scope), both until 2026-10-25;
>   - the Lab archive `br-icy-darkness-aho1v83p`, kept until B4 is certified.
>
> This header supersedes older deployment rows below.

> **2026-10-11 ~20:45Z — B3 ORGANIZATION LIFECYCLE ENFORCEMENT: PRODUCTION RELEASE PASS** (`docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-B3-RELEASE-2026-10-11.md`).
> - `main` is `8aec711` (PR #43). Production = **`dpl_8YEyT71Z1o3CUfb8qSCTZ9V1dr6o` @ `8aec711`**; rollback = `dpl_2QzBdDXtXAGSL49SYXoGd1vRbCrD` @ `ebb4f46`.
> - **22 migrations** in Production; the last one, `20261011200000_session_resolve_subject_account`, was applied 20:28:54–29:04Z.
> - First Admin / Break-glass v1 status:
>   - **B1 PASS**;
>   - **migration `Organization.status` + `Session.scope` PASS**;
>   - **B3 PASS**;
>   - next is **B2**, design first.
> - Sessions resolve only through `luxia_session_resolve`. It refuses a non-ACTIVE organization, subject or identity account, and accepts FULL sessions only until B2.
> - Neon backups:
>   - `br-cold-bread-ah1hlohl` (before B3) and `br-twilight-wildflower-ah68mp0p` (before status and scope), both until 2026-10-25;
>   - the Lab archive `br-icy-darkness-aho1v83p`, kept until B4 is certified.
>
> This header supersedes older deployment rows below.

> **2026-10-11 ~17:20Z — MIGRATION `Organization.status` + `Session.scope`: PRODUCTION RELEASE PASS** (`docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-MIGRATION-RELEASE-2026-10-11.md`).
> - `main` is `4e98edf` (PR #41). **21 migrations** in Production; the last one, `20261011180000_organization_status_session_scope`, was applied 17:16:44–57Z.
> - The application is unchanged: `dpl_2QzBdDXtXAGSL49SYXoGd1vRbCrD` @ `ebb4f46`, with rollback `dpl_Ao1hwzYREFMHVMqZotEHkQ67QAyJ`.
> - Both organizations are ACTIVE and every session is FULL.
> - The database enforces:
>   - status changes only by the operator role, under the governance lock;
>   - CLOSED is final;
>   - sessions are append-only;
>   - SUSPENDED and CLOSED resolve nothing.
> - Backup branch `br-twilight-wildflower-ah68mp0p` expires 2026-10-25. The rollback script is lossless while no status is in use.
> - **Binding for B4:** Prisma 5.20 does not report a failed COMMIT. End every transition with `SET CONSTRAINTS ALL IMMEDIATE` and re-read the state.
> - The Lab archive `br-icy-darkness-aho1v83p` is kept until B4 is certified.
>
> This header supersedes older deployment rows below.

> **2026-10-11 ~16:00Z — FIRST ADMIN / BREAK-GLASS V1, B1 LAST-ADMINISTRATOR GUARD: PRODUCTION RELEASE PASS** (`docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-B1-RELEASE-2026-10-11.md`).
> - `main` is `ebb4f46` (PR #38, merged pinned on `2d61ee6`). Production = **`dpl_2QzBdDXtXAGSL49SYXoGd1vRbCrD` @ `ebb4f46`**; rollback = `dpl_Ao1hwzYREFMHVMqZotEHkQ67QAyJ` @ `5e8c887`.
> - No migration: Production still has the **20** repository migrations applied.
> - No change may take a tenant from at least one durable administrator to none (`LAST_ADMINISTRATOR_PROTECTED`). Legrand Tech has 1 durable administrator. The neutralized Lab has 0 and is not frozen.
> - Proven in Production by a rolled-back `app_user` transaction, with nothing changed.
> - Neon archive branch `br-icy-darkness-aho1v83p` (the Lab's state before neutralization) is kept until B4 is certified, then deleted.
>
> This header supersedes older deployment rows below.

> **2026-10-11 ~14:20Z — CUSTOMER SELF-ONBOARDING V1 — PRODUCTION CERTIFICATION: PASS** (`docs/certification/CUSTOMER-SELF-ONBOARDING-V1-MULTI-ORG-CERTIFICATION-2026-10-11.md`).
> - `main` is `5e8c887` (PR #35, finding F1 fixed: passkey sign-in never lists credential IDs). Production = **`dpl_Ao1hwzYREFMHVMqZotEHkQ67QAyJ` @ `5e8c887`**; rollback = `dpl_7ZzzEA3DbQdAACKZP4f9V947gkad` @ `6f9de76`.
> - Two organizations exist: `legrand-tech` (active) and `luxia-certification-lab`. The Lab was **neutralized** by a provisional break-glass operator action: no session, accounts disabled, passkeys revoked, domain released. Its history is kept.
> - Recorded in the report: D1 (slug deviation, no security impact) and I1 (same-value update of Legrand's identity, only `updatedAt` changed).
>
> This header supersedes older deployment rows below.

> **2026-10-11 ~09:55Z — CUSTOMER SELF-ONBOARDING V1 RELEASED; LEGRAND TECH VALIDATED** (`docs/certification/CUSTOMER-SELF-ONBOARDING-V1-RELEASE-2026-10-11.md`).
> - `main` is `6f9de76` (merge of PR #32, CI run 38094537834 PASS).
> - **20 migrations** applied in Production. The latest, `20261011000000_customer_self_onboarding_v1`, was applied at 01:25:12Z. The business digest of the 45 tables is identical before and after, and Legrand Tech is now `legrand-tech`.
> - Production deployment: `dpl_7ZzzEA3DbQdAACKZP4f9V947gkad` @ `6f9de76`. Rollback deployment: `dpl_EDZXLTXRrHDbBbVGqcEhCTF3SnpW` @ `2d7ec62`. Database backup branch: `br-plain-union-ah2o23ll`, which expires 2026-10-25.
> - The second organization and the cross-tenant certification in Production are **not done yet** and need a separate approval.
>
> This header supersedes older deployment rows below.

> **2026-10-10 21:1xZ — SECURITY JOURNAL V1 — PRODUCTION CERTIFICATION: PASS** (`docs/certification/SECURITY-JOURNAL-V1-PRODUCTION-2026-10-10.md`). Production = `dpl_EDZXLTXRrHDbBbVGqcEhCTF3SnpW` @ `2d7ec62`. Also shipped since the dashboard certification: sober UI and readable copy (#25, #26), canonical audit journal and legacy roles out of navigation (#27). This header supersedes older deployment rows below.

> **2026-10-10 17:2xZ — DASHBOARD V1 — PRODUCTION CERTIFICATION: PASS** (`docs/certification/DASHBOARD-V1-PRODUCTION-2026-10-10.md`). Production = `dpl_48xvYWVVJUiZg1k9A53tyD7yf7tu` @ `5c71df8`. This header supersedes the deployment rows in section 1.

> **2026-10-10 15:41Z — RESOURCE ACCESS ONBOARDING V1 — PRODUCTION END-TO-END CERTIFICATION: PASS.** See `docs/certification/RESOURCE-ACCESS-PRODUCTION-E2E-2026-10-10.md`. Sections 4–11 below are updated accordingly; the post-ceremony state supersedes the pre-ceremony preflight figures.

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
| `main` | `5c71df83ac205c774f6ee2965e2ee3a777c7e5ec` (merge of PR #23, 2026-10-10T17:12:15Z) | VERIFIED 2026-10-10 |
| CI on `main` @ 8acea18 | `test-and-build` PASS: https://github.com/Boris13-tech/iam-azure-pme/actions/runs/38045671666 | VERIFIED 2026-10-10 |
| Production deployment | `dpl_48xvYWVVJUiZg1k9A53tyD7yf7tu`, target production, **READY**, `githubCommitSha` = `5c71df83ac205c774f6ee2965e2ee3a777c7e5ec` (Dashboard v1 certified). Previous: `dpl_3sAwruEpuGCbdhCQiTFQ5FRkCvQ3` (`082f199`), then `dpl_J3GnuWwpMFejURjG5ASKWc8nJK5U` (`8acea18`). | VERIFIED 2026-10-10 (Vercel API) |
| How it was deployed | Vercel API `POST /v13/deployments` with `gitSource` = GitHub repo 1270644438, ref `main`, exact sha. Built by Vercel from GitHub; no local upload, no env change, no migration (build = `tsc`, lint, `prisma generate`, `next build`). | VERIFIED 2026-10-10 |
| Rollback deployment | `dpl_3sAwruEpuGCbdhCQiTFQ5FRkCvQ3` (`082f199`, READY); then `dpl_J3GnuWwpMFejURjG5ASKWc8nJK5U` (`8acea18`, READY) | VERIFIED 2026-10-10 |
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

## 4b. Production state after the ceremony (read-only, 2026-10-10T15:42:51Z) — VERIFIED 2026-10-10

- Target entitlement: exactly **one** Assignment `abea167e-16dd-4fdd-87a2-30ae0f8c1041`, status **REVOKED**, DIRECT, sourceRef `bootstrap:d10049e4-0f2a-4d89-ba7c-0b6dee7998f2`. **0 ACTIVE.**
- Other Assignments: 21, digest `83e7540cab85667c96e63da4ba5f2183`, unchanged.
- Protected capability: **DENY**.
- Consequence for tooling: the preflight check `bootstrapAssignmentCountZero` counts all statuses, so it now reports `false` (1 REVOKED row). This is expected. Use "0 ACTIVE on the target entitlement" as the invariant from now on.
- No first-owner grant is active. A future permanent owner requires a new, separately approved design/manifest. The runner refuses a second initial bootstrap on this entitlement (`INITIAL_BOOTSTRAP_COLLISION`).

## 5. Abandoned artifacts (never reuse, extend or re-timestamp)

- Manifest binding `95e9b80de3e28890faf01eb41fb70002d6ef1efb6986815da8b8868799376232`, with assignment `d19ec5fa-…` and operation `6bb7d556-…`. These are hard-coded as forbidden in the runner.
- Manifest binding `7d1d9a7d59455e2cf9a0506a412daca598078a01a33cc7ca400c746355707451`, with assignment `001b95ec-5183-4280-92a3-dfa19c999272` and operation `f802788d-2123-4a5f-8ac8-71c821f7f73a`. It expired unused at 2026-10-10T12:49Z. There was no grant, as proven by the preflight at 14:34:01Z.
- Manifest binding `e2db955070cc09ee6b69fe10774ce62b78839f90dad9628f6794946ee339ee2b`: **completed** (certification PASS). It must never be replayed. Its receipt is REVOKED, and the runner returns DENIED with no recreation.
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
| **Resource Access Onboarding v1 Production end-to-end ceremony** (manifest `e2db9550…`): DENY → one bounded DIRECT grant → ALLOW → idempotent replay → modified replay refused → revoke → DENY → no recreation; no parasitic mutation | VERIFIED 2026-10-10 (`docs/certification/RESOURCE-ACCESS-PRODUCTION-E2E-2026-10-10.md`) |
| Production authenticated smoke on `8acea18`: (1) Entra login reaches the dashboard; (2) `/dashboard/users`, `/dashboard/resources`, `/dashboard/governance/sod`, `/dashboard/governance/access-reviews` and `/dashboard/resources/onboarding` render; (3) the authenticated protected route returns 403 `RESOURCE_ACCESS_DENIED` with an `evidenceId`; (4) sign-out, then LUXIA_LOCAL passkey login reaches the dashboard. **All 4 OK.** | OPERATOR-REPORTED 2026-10-10 |

| **Enterprise Identity Security Dashboard v1 Production certification** (PR #21 + #22 sessions projection + #23 overlapping-breakdown fix) | VERIFIED 2026-10-10 (`docs/certification/DASHBOARD-V1-PRODUCTION-2026-10-10.md`) |

## 7. Pending certifications

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
- Repo hygiene: the tracked `" README.md"` (leading space), which broke Windows checkouts, is renamed to `README.md` by the hygiene PR (`chore/fix-leading-space-readme`). After that merge, no sparse-checkout workaround is needed. Long paths still require `git config core.longpaths true` on Windows.
- Windows operators must run operator shell scripts through Git Bash (`C:\Program Files\Git\bin\bash.exe`). In PowerShell, `bash` resolves to the WSL launcher.
- PR12 must be rebased onto current `main` before any review.

## 11. Blockers / next gates

1. Resource Access tranche: CLOSED. Dashboard v1: CLOSED. Security Journal v1: CLOSED (Production PASS).
2. Next, per the operator roadmap: **Customer Self-Onboarding**, starting with a scope proposal that must be approved before any code.
3. Known v1 limits: pre-identity sign-in failures are not recorded (S3, needs a migration); passkey revocation is not offered (S2); there is no Entra MFA evidence (needs `amr`/Graph, PR12).
4. PR12: live provider credentials/consent/issuer, and a rebase.
