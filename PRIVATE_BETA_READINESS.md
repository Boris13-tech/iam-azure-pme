# LUXIA Identity: Private Beta readiness (single checklist)

| Item | State |
|---|---|
| Purpose | **The single checklist** for opening the Private Beta. It replaces the earlier gate register |
| Rules | Standard, section 17b (gate G1 to G8), plus the operator's Definition of Done of 2026-10-23 |
| Scope | [docs/engineering/PRIVATE-BETA-SCOPE.md](docs/engineering/PRIVATE-BETA-SCOPE.md) |
| Budget mode | €0 of new spending until the operator decides otherwise. `BLOCKED_BY_BUDGET` marks what cannot advance for free |
| Labels | **DONE**: demonstrated, with evidence. **PARTIAL**. **NOT DONE**. **BLOCKED**, with what blocks it. **LEGAL REVIEW REQUIRED**: drafted, waiting for counsel; technically finished is not legally finished |
| Updated | 2026-10-23 (main `62974fc`) |

## 1. Definition of Done

| # | Item | Status | Evidence | What remains | Blocked by |
|---|---|---|---|---|---|
| 1 | Core IAM in Production | **DONE** | Certifications in `docs/certification/` (identity baseline, resources and governance, SoD, access reviews, dashboard, security journal) | — | — |
| 2 | First admin and break-glass B1 to B5 | **DONE** | `docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-B*-RELEASE-*.md` | — | — |
| 3 | Providers needed by the pilot | **PARTIAL** | Passkeys PRODUCTION VERIFIED. Microsoft Entra PRODUCTION VERIFIED for the operator's tenant only (F1, F2) | **Finding (2026-10-23): no path activates a new Entra connection for a pilot's tenant.** On `main`, a new MICROSOFT_ENTRA connection starts DRAFT and the lifecycle only activates from DISABLED; F4 S5 (#80) activates OIDC_GENERIC connections only (`ACTIVATION_UNSUPPORTED` otherwise). Passkey-only pilots are unaffected. Entra pilots need an Entra activation path (class A) | Operator decision: passkey-only first pilots, or build the Entra activation path |
| 4 | Row-level security, cross-tenant isolation, anti-enumeration | **DONE** | Production certifications; PostgreSQL suites on every PR; the restore drills re-check isolation (each organization sees exactly its own rows) | — | — |
| 5 | Backup and restore drill | **DONE** | Drill B (2026-10-13, Production); EU-2 (2026-10-18, Frankfurt, identical); the CI backup and restore round trip runs on every PR | The quarterly drill (next by 2027-01-13), and again after the EU switch | — |
| 6 | Monitoring and alerting | **NOT DONE** | Design (zero cost) merged; slices 1 (#102) and 2 (#108) written, CI green | Review and merge; slices 3 (sign-in success SLI-01) and 4 (backup heartbeat); free accounts; one alert test per signal | Review (G2); accounts created by the operator |
| 7 | Secret scanning | **PARTIAL** | GitHub secret scanning with push protection; whole history scanned clean with gitleaks (local, and in #101's CI) | #101 merged (CI history scan on every change) | Review (G2) |
| 8 | CI/CD least privilege | **PARTIAL** | Actions pinned by SHA and least-privilege permissions (#84); Production environment protected (E17) | #89 (inputs through env, mode allowlist), #86 (dispatch only), then `main` protection | Review (G2) |
| 9 | Production rollback documented | **DONE** | Deployments: redeploy the recorded previous deployment. Migrations: rollback scripts with CI drills since B2. EU switch: runbook section 6 | — | — |
| 10 | Incident runbook | **PARTIAL** | `docs/operations/LUXIA-IDENTITY-V1-RUNBOOKS.md` (16 scenarios), the backup and break-glass runbooks, templates | Runbook entries for each monitoring alert; one tabletop exercise | Monitoring (item 6) |
| 11 | Legal minimum | **LEGAL REVIEW REQUIRED** | `docs/legal/`: privacy policy, pilot agreement, DPA and annexes, retention, subprocessors, data subject requests, incident notification | Counsel review; the entity; retention enforced; contract gaps (Vercel Hobby and GitHub free have no DPA) | Counsel, entity and Vercel Pro: `BLOCKED_BY_BUDGET` |
| 12 | Customer onboarding documented | **NOT DONE** | — | A pilot onboarding guide | — (in progress) |
| 13 | No stale critical PR | **BLOCKED** | The class A queue is current and CI green, but unmerged | Independent human review | Review (G2) |
| 14 | `main` green | **DONE** | CI #392 on `8658d41`, then every merge since | — | — |
| 15 | No unaddressed critical or high finding | **PARTIAL** | Dependabot: sharp and source-map-js fixed in #118; next alerts not exploitable here (triaged) | postcss (2 high, build time only, needs next 16): operator risk acceptance; #89 and `main` protection merged | Review (G2); operator acceptance |

## 2. Private Beta gate (standard, section 17b)

| # | Criterion | Status | What turns it green |
|---|---|---|---|
| G1 | Beta-critical capabilities PRODUCTION VERIFIED | **PARTIAL** | Passkey-only pilots: met. Entra pilots: an Entra activation path (DRAFT → TESTING → ACTIVE with a fresh proof sign-in), then one verified sign-in per pilot tenant |
| G2 | Relevant class A changes independently reviewed | **BLOCKED** (no human reviewer yet; automated reviews complement but never replace one) | A reviewer: per-PR reviews, then one consolidated review at an exact SHA |
| G3 | No unresolved critical finding in the Beta scope | **PARTIAL** | #89, #91, #86 merged; `main` protection |
| G4 | Rollback and recovery verified | **PARTIAL**: rehearsed on the target platform (EU-2, G4 runs A and B) | Repeat after the Production switch (EU-4) |
| G5 | Gate evidence current | **PARTIAL** | Fresh evidence at the gate; the WORM evidence store and a protected private repository for gate tools (`BLOCKED_BY_BUDGET`) |
| G6 | Minimum application monitoring active | **NOT DONE** | Item 6 |
| G7 | Human alert path tested end to end | **PARTIAL** (backup freshness only) | One test per application alert |
| G8 | Legal, retention and hosting blockers closed | **NOT DONE** | Counsel and entity; retention and deletion enforced (R1 to R8); commercial hosting with a DPA |

## 3. Open pull requests (2026-10-23)

| PR | Title (short) | Class | Classification |
|---|---|---|---|
| #89 | Production workflow inputs through env; mode allowlist | A | **REQUIRED FOR PRIVATE BETA** |
| #91 | Authorization mode fails closed in Production | A | **REQUIRED FOR PRIVATE BETA** |
| #86 | Production operations by dispatch only (after #89) | A | **REQUIRED FOR PRIVATE BETA** |
| #101 | gitleaks scan of the whole history in CI | A | **REQUIRED FOR PRIVATE BETA** |
| #102 | Monitoring slice 1: liveness, protected readiness | A | **REQUIRED FOR PRIVATE BETA** |
| #108 | Monitoring slice 2: scrubbed errors, SLI-03 | A | **REQUIRED FOR PRIVATE BETA** |
| #107 | R1: no network identifiers stored with sessions | A | **REQUIRED FOR PRIVATE BETA** |
| #104 | EU-3: functions in Frankfurt (merge at the switch) | A | **REQUIRED FOR PRIVATE BETA** |
| #118 | Patch-level security updates (next, sharp, source-map-js, vite) | Dependencies | **DEPENDENCY UPDATE** (replaces #93, #96, #98, #115) |
| #93, #96, #98, #115 | Dependabot patch updates | Dependencies | **SUPERSEDED** by #118 |
| #94 | msal-node 3 → 7 (major) | Dependencies | **REQUIRED AFTER BETA** |
| #95 | tailwindcss 3 → 4 (major; CI fails) | Dependencies | **REQUIRED AFTER BETA** |
| #97 | next 16 (major; CI fails) | Dependencies | **REQUIRED AFTER BETA** |
| #76 to #80 | Generic OIDC connections, F4 S1 to S5 | A | **REQUIRED AFTER BETA** for passkey-only pilots. **The base of the Entra activation path** if Entra pilots are wanted: S3 (connection test) and S5 (proof and first activation) would be extended to the Entra profile |
| #117 | Corrections from automated reviews | C | **DOCUMENTATION ONLY** |

## 4. Critical path (single)

1. **Reviewer engaged.** The class A queue in this order: #89 → #91 → #86 → `main` protection → #101 → #107 → #102 → #108.
2. **Build the remaining G8 and G6 mechanisms**, each in class A with clone rehearsals:
   - retention and deletion: R2 redaction, R3 and R4 purges, R5 journal-period removal, R7 deletion at the end of a pilot;
   - the backup job moved off GitHub-hosted runners;
   - monitoring slices 3 and 4.
3. **Free monitoring accounts and probes**; one end-to-end alert test per signal (G6, G7).
4. **Production switch to Frankfurt** (EU-4, operator gate), then the G4 rehearsal again.
5. **Commercial hosting with a DPA** (Vercel Pro, or the all-Azure path): operator budget decision.
6. **Counsel review and the entity**; the documents adapted to the entity's country.
7. Fresh gate evidence (G5), gate review, release candidate, and onboarding of the first pilot.

## 5. Human gates (only the operator)

| Gate | Why |
|---|---|
| Find an independent human reviewer | G2; nothing in class A can merge without one (standard, section 8) |
| Budget: Vercel Pro (about €18.5 a month), or a durable €0 path on Azure | Commercial use and a DPA for the hosting |
| Entity (recommended: a Romanian SRL) and the first pilot's terms (free or paid) | Signatory of the contracts |
| Counsel review (a free consultation is possible on a complete package) | G8 |
| Production migrations and deployments, including the EU switch | Production gate |
| Accept the residual postcss risk until next 16 | Item 15 |
