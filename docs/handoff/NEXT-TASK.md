# LUXIA Identity — NEXT TASK

Read `docs/handoff/CURRENT-STATE.md` first.

## Completed (2026-10-10)

- Resource Access Onboarding v1: Production E2E PASS.
- Dashboard v1: Production certification PASS.
- Security Journal v1: Production certification PASS (`dpl_EDZXLTXRrHDbBbVGqcEhCTF3SnpW` @ `2d7ec62`).

## In progress: Customer Self-Onboarding v1

- **Scope** validated by the operator (O1–O5 and 17 mandatory requirements). See PR #31, `docs/product/CUSTOMER-SELF-ONBOARDING-V1-SCOPE.md`.
- **Code** is complete in **draft PR #32** (`feat/customer-self-onboarding-v1`), steps 1 to 8 of the approved order. CI is green on PostgreSQL.
- **Traceability and certification plan**: `docs/architecture/CUSTOMER-SELF-ONBOARDING-V1.md`.
- **Migration, rollback and forward-fix**: `docs/operations/CUSTOMER-SELF-ONBOARDING-V1-MIGRATION.md`.

## Next: step 9, certification on a real second organization (each gate needs explicit approval)

1. The operator reviews PR #32 and confirms the four decisions listed in its description.
2. Rehearsal on an isolated Neon clone of Production: migration, identical business digest, privilege gate.
3. Merge PR #32 (pinned SHA), with CI on the merge SHA.
4. Production migration with the owner connection, with a read-only digest before and after.
5. Deployment of the exact SHA, keeping the previous deployment as rollback.
6. A beta code issued by the operator, then a real second organization created end to end, with the ten proofs of the plan.

Order matters: the migration comes before the deployment (the new code needs the new functions). The previous code runs unchanged on the new schema.

## Forbidden

- Production grants or business-data mutation outside the approved ceremony.
- Merge, deploy, env or migration changes without explicit human approval.
- Any change to PR12.
