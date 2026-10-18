# Private Beta gate register (G1 to G8)

| Item | State |
|---|---|
| Rule | [Standard, section 17b](LUXIA-MISSION-CRITICAL-ENGINEERING-STANDARD-v1.md): the first limited pilot starts only when all eight criteria hold |
| Budget mode | **€0 of new spending** until the operator decides otherwise (2026-10-18). A criterion that cannot advance for free is marked `BLOCKED_BY_BUDGET`; the others continue |
| Scale | `DONE` needs reproducible evidence on what the pilots use. `REHEARSED` means proven on the target platform outside Production. Drafts and designs do not count as progress toward `DONE` |
| Public repository rule | Security-sensitive details that are not fixed yet stay in the operator's private record; this register gives status only |
| Updated | 2026-10-18 |

## Status

| # | Criterion | Status | Evidence | What remains | Blocked by |
|---|---|---|---|---|---|
| G1 | Beta-critical capabilities are PRODUCTION VERIFIED | **Mostly met** | Beta scope approved 2026-10-18 (1 to 3 organizations, at most 50 users in total, passkeys and Microsoft Entra, no generic OIDC). Core capabilities PRODUCTION VERIFIED (certifications in `docs/certification/`). Leaver scenario proven on PostgreSQL in CI (`tests/resources/leaver-postgres.test.ts`, #99) | Microsoft Entra for a pilot's **own** tenant: an onboarding check per pilot | — |
| G2 | Every relevant class A change is INDEPENDENTLY REVIEWED | **Not met** | Briefs and threat models prepared for the class A queue | A competent human reviewer: per-PR reviews, then one consolidated review at an exact SHA with a traceability matrix | External: a volunteer reviewer (no budget) |
| G3 | No unresolved critical security finding affects the Beta scope | **Not met** | Dependabot alerts on, none critical for the Beta scope; secret scanning in CI prepared (#101) | Fixes waiting for review (#89, #91, #101); `main` protection after #86 | G2 |
| G4 | The Production rollback and recovery path is verified | **REHEARSED** | EU-2 (real data, read only): restore into Neon Frankfurt identical, 52 tables, 1,609 rows, behaviour checks 6/6. G4 runs A and B: the application in `fra1` switched to a Frankfurt database, including a **restored** one, 9/9 checks each (`docs/operations/EU-MIGRATION-RUNBOOK.md`, section 6b) | Repeat after the Production switch (EU-4), since a change of region voids it | EU-3 review (G2) |
| G5 | The required gate evidence is current | **Partly met** | Gate evidence sealed (SHA-256 manifests) with a verified durable copy | Evidence for the commit deployed at the gate; version control of the gate tools in a protected private repository | Protected private repository: `BLOCKED_BY_BUDGET` (needs a paid GitHub plan); local alternatives remain |
| G6 | Minimum application monitoring is active | **Not met** | Design merged (#92, zero cost); liveness and readiness (#102) and scrubbed error events with SLI-03 (#108) in review | Review, then free accounts and probes at the execution gate | G2; accounts are created by the operator |
| G7 | The human alert path is tested end to end | **Partly met** | Backup freshness alert tested end to end (E4, 2026-10-13) | The same test for each application alert, after G6 | G6 |
| G8 | Legal, retention and hosting blockers applicable to the pilot are closed | **Not met** | Retention mechanisms designed (#103); R1 in review (#107); hosting path at €0 to the EU proven (Vercel Hobby `fra1` + Neon Free Frankfurt) | Hosting terms that allow commercial use (Vercel Pro); counsel review of what the pilot signs; the legal entity; retention enforced (R1 to R3) | Hosting: `BLOCKED_BY_BUDGET`. Legal: external (free paths only); the entity's country is not decided yet |

## What turns each criterion green

- **G1:** one Entra onboarding check per pilot tenant, or passkey-only pilots.
- **G2 and G3:** a reviewer; then merges in the order #89, #91, #86, then `main` protection.
- **G4:** the Production switch (EU-4), then the same rehearsal on Production's new platform.
- **G5:** fresh gate evidence for the deployed commit at the gate.
- **G6 and G7:** the reviewed monitoring slices, free accounts, probes, and one end-to-end alert test per signal.
- **G8:** a budget decision for commercial hosting, counsel, the entity, and R1 to R3 merged and running.
