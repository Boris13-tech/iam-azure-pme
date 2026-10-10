# LUXIA Identity — NEXT TASK

Read `docs/handoff/CURRENT-STATE.md` first.

## Next objective

Final review and promotion of PR #16 (operator-only canonical browser evidence transport).

## Allowed

- Review of PR16 (code, tests, certification evidence).
- Documentation updates (handoff docs, certification summaries).
- Non-mutating verification: GitHub/CI reads, git inspection, read-only checks.

## Forbidden

- Any Production grant or Production data mutation.
- Manifest generation, registration, or reuse of any old manifest/approval.
- Merging PR16 (or any PR) without explicit human approval.
- Any change to PR12, or mixing PR12 into PR16.
- Starting a new product slice (dashboard, onboarding, Alma, Sovereign Runtime, etc.).
- Changes to `app/`, `lib/`, `prisma/`, the authorization model, runner semantics or the manifest model in PR16.

## Success criteria

- PR16 is Ready for Review.
- CI PASS on PR16's exact head SHA.
- No scope broadening: `git diff main...<PR16 head> -- app lib prisma` is empty, and no operator module is imported from `app/` or `lib/`.

## Stop condition

STOP once the success criteria are met, and report the PR16 SHA, CI run, review status and remaining blockers. Wait for an explicit human merge decision. Never infer PASS.

## After explicit merge approval (each step is a separate gate)

1. CI PASS on the exact merge SHA, and Production deployment of that exact SHA.
2. Non-mutating Production smoke: Entra login, LUXIA_LOCAL/passkey, canonical session, dashboard, JML, Resources, SoD, Access Reviews, Resource Onboarding, protected capability DENY, bootstrap Assignment count = 0.
3. Read-only revalidation: binding, Subject ACTIVE, SoD NONE, count 0, DENY, deployed SHA. Then generate a NEW manifest (new assignmentId/operationId/validFrom, validUntil ≤ 1 h, new binding). **STOP for explicit human approval.**
4. Ceremony: DENY → exactly one bounded DIRECT RESOURCE grant → ALLOW → exact replay idempotent → modified replay DENY → revoke → DENY → revoked replay no recreation. Then STOP.
