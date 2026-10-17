# Gap analysis against the Mission-Critical Engineering Standard v1 (2026-10-17)

| Item | State |
|---|---|
| Basis | `main` at `4d92479`, the repository's workflows and documents, the recorded operator evidence, and read-only checks of the repository settings (2026-10-17) |
| Scale | **VERIFIED:** the requirement is met and the evidence was checked. **PARTIAL:** met in practice or in part, but not fully or not codified. **UNKNOWN:** not established. **MISSING:** not in place |
| Public repository rule | Gaps that are security-sensitive and not yet fixed are counted here, not described. Their detail is in the operator's private annex |

## 1. Summary

| Area (standard section) | Status | Headline |
|---|---|---|
| Seven superior invariants (1) | **PARTIAL** | Mechanisms enforce all seven (VERIFIED). The list itself was never recorded: it is proposed in this PR, to be confirmed |
| Assurance lifecycle (2) | **PARTIAL** | A five-step ladder was used consistently (UNKNOWN → DESIGNED → IMPLEMENTED → VERIFIED → PRODUCTION VERIFIED). THREAT-MODELED, ADVERSARIALLY TESTED, INDEPENDENTLY REVIEWED, STAGING VERIFIED, PRODUCTION GATED and OPERATIONALLY PROVEN are new |
| Change classes (3) | **MISSING** | Not defined until now |
| ADR / RFC (4) | **PARTIAL** | 2 ADRs and many designs with dated operator decision tables. No templates, index or status lifecycle |
| Threat modeling (5) | **PARTIAL** | Security-model sections in the designs (sovereign rules R1–R10 with a proof column; F3 and F4 security models). No per-change threat model with STRIDE per boundary and traceability |
| Trust-boundary registry (6) | **MISSING** → created in this PR (initial content) | Boundaries were implicit in designs |
| Adversarial testing (7) | **PARTIAL**, VERIFIED for recent phases | F2–F4 and the B-series have negative tables, race, replay, outage, cross-tenant and mix-up tests, database-level tests and architecture tests. Control-sanity (mutation) checks are not recorded; no traceability tables |
| Independent review (8) | **MISSING** | No review by someone other than the author is recorded for any change. Class A changes were merged on the author's reports and the operator's approval. Repository-setting gaps: held privately |
| Staging verification (9) | **PARTIAL** | Fresh-clone rehearsals with sealed evidence are VERIFIED (M1, M2, F3). The staging soak workflow exists but last ran 2026-09-20; staging parity with Production is UNKNOWN |
| Production gates (10) | **PARTIAL**, practice VERIFIED | Gates M1, M2, F3, F1 and F2 ran with dry runs, confirmation tokens, refusal on drift, real-scenario proofs and closures. Gate procedures and tools are not version-controlled; no template until now |
| Rollback (11) | **PARTIAL** | Rollback scripts with CI drills exist for every migration since B2 (9 scripts); the 19 earlier migrations have none. Deployment rollback targets are recorded for recent deploys |
| Evidence (12) | **PARTIAL, at risk** | Sealed manifests (SHA-256, index, read-only) are VERIFIED for every gate. **But the detailed gate evidence and gate tools are kept only in one local working folder, outside version control, with no recorded durable copy (UNKNOWN)** |
| Migration assurance (13) | **VERIFIED** for current practice, PARTIAL for history | Expand-only, lock timeouts, forced RLS, function-privilege gate, dump/restore stability, rollback drills, fresh-clone rehearsal, gate, backup verification: all proven in F2, F3 and F4. Codified now |
| Supply chain (14) | **PARTIAL** | VERIFIED: committed lockfile with `npm ci`; secret scanning with push protection on. MISSING: SBOM. Further gaps held privately (5) |
| SLO / SLI (15) | **MISSING** (backup freshness PARTIAL) | No automated monitoring for sign-in, sessions or the API; backup freshness alerting exists (E4) |
| Incidents and runbooks (16) | **PARTIAL** | Severity S1–S3 defined (draft, legal review pending); 16 runbook scenarios written (`LUXIA-IDENTITY-V1-RUNBOOKS.md`), plus the break-glass and backup runbooks. Exercises: only the restore drill (E1) is recorded. No post-incident review process; one operator, no on-call |
| OPERATIONALLY PROVEN (17) | **MISSING** | No capability meets the definition yet: SLIs unmeasured, alert paths unproven except backup freshness. Closest: the backup chain (E1, E4) |

Counts over these 17 areas:
- VERIFIED: 1 (migration assurance, current practice);
- PARTIAL: 11;
- MISSING: 5 (change classes, trust-boundary registry, independent review, SLO/SLI, OPERATIONALLY PROVEN). This PR creates the registry and the change classes as documents, which is a start, not proof;
- UNKNOWN items inside the areas: evidence durability, staging parity, runbook exercises.
- Security-sensitive gaps held privately: 6, in the operator's private annex.

## 2. The seven invariants: enforcement today

| Invariant | Status | Evidence | Gap |
|---|---|---|---|
| I1 Authority is LUXIA's alone | VERIFIED | Architecture tests (no adapter writes authority tables, no claim to authority); route tests with authority claims (F4 S4); R6 has no mapping table | Retroactive threat model and review |
| I2 Isolation enforced by the database | VERIFIED | FORCE RLS (M2 and every new table); `app_user` NOBYPASSRLS; RLS suites across organizations; architecture test of unscoped reads (#73) | No periodic isolation check in Production (COR-01) |
| I3 Fail closed, answer generically | VERIFIED | R8 negative tables (F1, F4 S4); the authorization gateway denies on error; identical answers for unknown and refused (B3, F4) | — |
| I4 No security action without evidence, append-only | VERIFIED | T0 append-only triggers; session and evidence in one transaction (W1); test runs append-only; journal labels guard (B5) | No reconciliation in Production (COR-02, COR-03) |
| I5 Secrets referenced, never exposed | PARTIAL | References only (database CHECKs); redacting leases; tests that errors carry no secret; secret scanning on | The vault is not wired yet (F3 steps 1–7, gated); Production still reads the Microsoft client secret from the platform environment |
| I6 Continuity: no lock-out, no silent data loss | PARTIAL | LUXIA_LOCAL always ACTIVE (database guard); B2 recovery, B4 break-glass; R5 (outage never revokes a session) tested; hourly independent backup, CI round trip, drill B | 4-hour RPO not guaranteed (external alerting and catch-up unproven); one operator |
| I7 Gated and reversible | PARTIAL | Gates with sealed evidence; rollbacks with drills since B2; exact-commit deploys; R10 replaceability planned (F4 S8) | Gate tooling not version-controlled; evidence durability unknown; 19 early migrations without rollback |

## 3. Assurance debts (work already PRODUCTION VERIFIED)

These keep their state (standard, section 18). The missing intermediate states are recorded, not relabelled.

| Item | Missing states |
|---|---|
| F1 OIDC core; #64 passkey ceremony; G1 correction | THREAT-MODELED (formal), INDEPENDENTLY REVIEWED |
| F2 M1, F2 code, M2 | THREAT-MODELED (formal), INDEPENDENTLY REVIEWED. Destructive transitions (DISABLE, QUARANTINE) verified in CI and rehearsal only, never in Production (by operator decision, until an F4 test connection exists) |
| F3 references migration | INDEPENDENTLY REVIEWED |
| B-series, T0, E1 | INDEPENDENTLY REVIEWED; runbook exercises (except E1's drill) |
| Backup schedule gate (#68) | Catch-up path never observed in Production |
| F4 S1–S5 (#76–#80, not in Production) | THREAT-MODELED, traceability tables, INDEPENDENTLY REVIEWED (required before merging #76, decision F4-13), STAGING VERIFIED, gates |

## 4. Recommended order (for the operator's decision)

1. **Evidence durability (I7, section 12).** Copy the sealed gate evidence and gate tools to a durable private store with its own backup, and record where. This is the most urgent gap: today it rests on one working folder.
2. **Independent review (section 8).** Name a human reviewer for class A, starting with #76 (S1), which decision F4-13 already requires. Apply the repository-setting fixes in the private annex.
3. **Threat models for F4 S1–S5** with traceability tables, before any F4 gate.
4. **Minimum monitoring** for SLI-01, SLI-03 and SLI-05 with alerts to a human: the precondition of every OPERATIONALLY PROVEN claim.
5. **Version-control the gate tooling**, without evidence or secrets, as a private repository or a private directory in the evidence store, so that gates are reproducible.
6. Runbook exercise schedule (quarterly), the post-incident review process, and a second person able to act (E7).
7. Retroactive reviews of the PRODUCTION VERIFIED items (section 3), highest-risk first: F1, M2, T0.
