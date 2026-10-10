# LUXIA Identity — CURRENT STATE

Snapshot: 2026-10-10, written by Claude Code after the PR #16 documentation fix commit.
The repository is the source of truth. No agent may rely on another agent's memory.

Evidence labels:

- **VERIFIED 2026-10-10**: observed directly in this snapshot (GitHub API, CI, git objects, source review).
- **VERIFIED FROM PRIOR CERTIFICATION EVIDENCE**: taken from committed `docs/certification/*` files. **Not** re-executed or re-read from the database in this snapshot.

## 1. Branches and SHAs

| Item | Value | Evidence |
|---|---|---|
| `main` | `e4038f89924c3e52e904a3578d086276ab890b72` (PR #15 merge) | VERIFIED 2026-10-10 |
| CI on `main` @ e4038f8 | success | VERIFIED 2026-10-10 |
| Production deployed SHA | `e4038f89924c3e52e904a3578d086276ab890b72` | VERIFIED 2026-10-10 from the GitHub deployment record (environment `Production`, created 2026-10-09T11:09:22Z). The Vercel control plane was not queried in this snapshot. |
| Production smoke after the e4038f8 deploy | **No committed evidence found** | VERIFIED 2026-10-10 (absence in `docs/certification`) |

## 2. Pull requests

| PR | Head SHA | Status | Evidence |
|---|---|---|---|
| #16 Operator-only canonical browser evidence transport (`fix/operator-browser-evidence`) | `12e5eebb463ddf2f25a8990ca54d38f4d4ed6dfc` | Based directly on `main`. Changes only operator scripts, certification tests and allowlists, and docs. `app/`, `lib/` and `prisma/` are unchanged. See section 9 for CI and Ready-for-Review status. | VERIFIED 2026-10-10 |
| #12 Providers Management v1 (`feat/providers-management-v1`) | `d604a48fa62fbec65676c0423a08645805d67129` | Draft. CI `test-and-build` PASS on its own head. **Merge state CONFLICTING** with `main` (`app/dashboard/layout.tsx`). It is based on old `main` `4b0d228` (before PR13). It shares no files with PR16. | VERIFIED 2026-10-10 |

Merged: #1–#11, #13 (Resources & Governance v1), #14 (Resource Access Onboarding v1), and #15 (operator runner + release binding, merged 2026-10-09T11:02:35Z). VERIFIED 2026-10-10.

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

## 4. Production Resource binding state

| Item | State | Evidence |
|---|---|---|
| Resource / RESOURCE Scope / Entitlement exact binding | true (active) | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE: `PR15-RELEASE-BINDING-RECERTIFICATION-2026-10-09.md`, read-only SQL at 2026-10-09T06:23:54Z, deployment `5704558`. |
| Subject lifecycle | ACTIVE | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (same source) |
| SoD for the target grant | ALLOW (no conflict) | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (same source) |
| Protected capability | DENY | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (same source) |
| **Bootstrap Assignment count on the target entitlement** | **0** (21 other existing assignments) | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (same source) |
| Production first-owner grant ever executed | NO | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE: `PR15-MANIFEST-EXPIRY-2026-10-09.md`, `PR14-BOOTSTRAP-ABANDONED-2026-10-08.md` |
| `PRODUCTION_REGISTRATIONS` (runner registry) | empty | VERIFIED 2026-10-10 (source) |

The last read-only Production baseline was taken **before** the e4038f8 deploy. It must be re-taken (non-mutating) before any new manifest is generated.

## 5. Abandoned artifacts (never reuse, extend or re-timestamp)

- Manifest binding `95e9b80de3e28890faf01eb41fb70002d6ef1efb6986815da8b8868799376232`, with assignment `d19ec5fa-…` and operation `6bb7d556-…`. These are hard-coded as forbidden in the runner.
- Manifest binding `2f11099801881d9109a8c5c8b313643a4762b93d8169f675307c24ac48041a89`, with assignment `f5faba6f-7b29-4704-94b4-608001827597` and operation `cd2ac2e0-a103-4ad1-8125-5f59957afbfb`. It expired 2026-10-09T12:18Z and its detached approval is void.

## 6. Completed certifications

| Certification | Evidence |
|---|---|
| Identity baseline (Organization/Tenant, forced RLS, Subject, IdentityAccount, Entra, LUXIA_LOCAL/passkeys, sessions, JML, canonical audit) | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (earlier PRs and certification docs) |
| Resources & Governance v1, SoD v1, Access Reviews v1, SQL function privilege hardening | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (`PR13-*`, `SOD-V1-*`, `ACCESS-REVIEWS-V1-*`) |
| Resource Access Onboarding v1 application layer (pre-bootstrap) | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (`RESOURCE-ONBOARDING-PREBOOTSTRAP-2026-10-08.md`) |
| Operator runner on clone: DENY → one bounded DIRECT grant → ALLOW → replay → revoke → DENY → no recreation | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (`PR15-RELEASE-BINDING-RECERTIFICATION-2026-10-09.md`) |
| PR16 browser-evidence transport on clone (ci05): 70 files, 367 passed, 11 gated skipped, 0 failed; no deadlock, open transaction or advisory lock; app_user least privilege | VERIFIED FROM PRIOR CERTIFICATION EVIDENCE (`OPERATOR-BROWSER-TRANSPORT-2026-10-09.md`) |
| PR16 static security review: env guards, manifest binding, detached approval, expiry, replay, revoke no-recreation, no browser bypass, no secret in diff | VERIFIED 2026-10-10 (source review) |

## 7. Pending certifications

- **Resource Access Onboarding v1 Production end-to-end**: NOT EXECUTED. No Production grant has ever run.
- Production non-mutating smoke on the deployed SHA: pending (none recorded for e4038f8; required again after the PR16 merge).
- PR12 live provider certification: Entra BLOCKED (dedicated credentials/consent missing), Google BLOCKED (same), OIDC BLOCKED (no approved issuer).

## 8. Security invariants (non-negotiable)

- Default deny and tenant isolation, with PostgreSQL RLS enabled and forced on controlled tables.
- `app_user` is NOSUPERUSER and NOBYPASSRLS, owns no controlled table, and there is no PUBLIC EXECUTE on LUXIA functions.
- No secret, token or DB URL in logs. No silent grant, no implicit first owner, and `resources.manage` never implies Resource access.
- The browser never controls Subject, Resource, action or grant. There is no legacy Role authority.
- No cross-tenant enumeration. Every privileged operation is audited, replay-protected, idempotent and fails closed.
- The first owner is created only by an explicit operator ceremony with a detached human approval.

## 9. PR16 CI / review status

VERIFIED 2026-10-10:

- CI on the exact head `12e5eebb463ddf2f25a8990ca54d38f4d4ed6dfc`: `test-and-build` **PASS**. Run: https://github.com/Boris13-tech/iam-azure-pme/actions/runs/38045374460. Vercel Preview PASS. The Production activation/identity jobs were skipped, as designed for PRs.
- Previous head `f22d856`: CI PASS (run 37969954967).
- Ready for Review: **YES** (marked 2026-10-10 with explicit human authorization). Merge state CLEAN. **Not merged.**
- Commit `12e5eeb` changes only `.gitignore` (raw certification reports excluded) and `docs/certification/OPERATOR-BROWSER-TRANSPORT-2026-10-09.md` (observed CI recorded).

## 10. Known limitations

- The Production runner is specific to the operator's Windows machine: it resolves the Vercel CLI through `%APPDATA%`.
- Browser evidence is bound to its probe by time only: the event must be fresh after the probe starts. The server event does not carry the probeId. Fixed actor/tenant/resource/action/assignment checks and a consumed-ID set mitigate this.
- Evidence freshness compares the app server's `occurredAt` with the operator's local clock, with no lower-bound tolerance. Clock skew fails closed.
- In the runner, the modified-replay check is a local `validate()` refusal. The ceremony-level modified-bytes refusal is covered by clone tests.
- **Repo hygiene issue:** a tracked file named `" README.md"` (leading space) breaks a plain checkout on Windows. Workaround: `git config core.longpaths true` plus a sparse-checkout excluding `/ README.md`. A separate fix is proposed (rename or remove), outside PR16.
- PR12 must be rebased onto current `main` before any review.

## 11. Blockers

1. PR16 merge: explicit human authorization.
2. After merge: CI on the exact merge SHA, deployment of that exact SHA, and a non-mutating Production smoke.
3. New manifest: fresh read-only Production revalidation, then generation, then **explicit human approval**.
4. PR12: live provider credentials/consent/issuer, and a rebase.
