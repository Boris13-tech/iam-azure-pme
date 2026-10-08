# PR #13 SQL function least privilege

Baseline: `3eca34eef2cf4a21dd247324a64b266173c0f302`.
Scope: privilege statements, certification tests/bootstrap only. No changes to
SoD / Access Review business logic, application routes, identity models or UI.
Production is excluded; PR #13 remains Draft; PR #12 is independent and unchanged.

## Exact privilege matrix

Observed on the isolated Neon database `luxia_reviews_cert`, project
`hidden-leaf-91460552`, branch `br-raspy-wave-ahocn5jt`.
This schema-only certification branch expires at `2026-10-09T11:51:33Z`.
The expired October 4 branch is not reused and no migration checksums/history
are rewritten. Credentials are injected in process memory, not written to files.

| Function | Owner | PUBLIC EXECUTE | app_user EXECUTE | Owner EXECUTE | Runtime requirement | Trigger dependency |
| --- | --- | --- | --- | --- | --- | --- |
| `luxia_sod_scope_contains(text,text,text,text)` | `neondb_owner` | NO | YES | YES | Nested call under SECURITY INVOKER; no application-level SQL call | Called by assignment guard |
| `luxia_sod_assignment_guard()` | `neondb_owner` | NO | NO | YES | Existing trigger invocation only | `assignment_static_sod` |
| `luxia_review_immutable_guard()` | `neondb_owner` | NO | NO | YES | Existing trigger invocation only | `review_campaign_immutable`, `review_item_immutable` |

In GitHub's ephemeral PostgreSQL CI database the migration owner is `prisma`.
The migration conditionally grants only the helper to an existing `app_user`.
CI creates that role *after* migrations, so its bootstrap explicitly grants that
same helper (not the trigger functions). The isolated runner does likewise.
No role membership, SECURITY DEFINER conversion or RLS bypass is introduced.

The helper grant is required by the SQL invoker call chain, not by a direct call
from application code. A real negative test revokes its EXECUTE on the isolated
database, uses the actual `app_user` connection and inserts a conflicting
Assignment: the expected error is SQLSTATE `42501` naming the helper. The denied
insert transaction rolls back; a `finally` restores the helper ACL. Resource test
files execute sequentially so no other suite observes the temporary revocation.
With the helper grant present the same class of
insert fails with SQLSTATE `23514` / `SOD_CONFLICT`, with no denied Assignment
persisted. Existing trigger entry points have no runtime EXECUTE grant throughout.

## Generic fail-closed gate

```sql
SELECT n.nspname, p.proname, p.proacl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname LIKE 'luxia_%';
```

`tests/resources/function-privileges.test.ts` expands effective ACLs with
`aclexplode(coalesce(proacl, acldefault('f', proowner)))`; NULL/default ACLs cannot
evade the PUBLIC check. There is no PUBLIC EXECUTE whitelist. It rejects all
unexpected ACL grantees and runtime grants; checks owner rights, a nonprivileged
unrelated PostgreSQL role, anonymous roles if present, and all three actual
trigger dependencies. A newly added LUXIA function must update the explicit
inventory and remain non-public. Architecture checks verify that every function
created by the three migrations revokes PUBLIC immediately after its body.

## Certification evidence

Final isolated replay: `LUXIA_RESOURCE_FULL=true` with the owner URL injected
only in memory, using `scripts/certify-resources-local.cjs`.

| Gate | Observed result |
| --- | --- |
| Corrected migrations | PASS |
| No implicit grants / PUBLIC EXECUTE on LUXIA functions | PASS / NONE |
| Runtime EXECUTE least privilege | PASS (helper only) |
| app_user NOSUPERUSER / NOBYPASSRLS / no ownership | PASS |
| PostgreSQL / RLS ENABLED + FORCED | PASS |
| SoD enforcement / concurrent conflicting assignments | PASS / DENY |
| Access Review KEEP / REVOKE / immutability | PASS |
| Cross-tenant access | DENY |
| Canonical audit | PASS |
| Existing identity / legacy preservation assertions | PASS (no feature mutations) |
| Resources unit / architecture / real PostgreSQL / persisted-session HTTP | PASS |
| Existing security / provider contracts including Entra parity / identity | PASS |
| Operations / operational certification / cutover readiness | PASS |
| TypeScript / lint / production build (local only) | PASS |
| Local CI-equivalent | PASS |

The function bodies were compared against the baseline and are unchanged.
Application/core files, Prisma models, `next-env.d.ts` and `package-lock.json`
are unchanged. The package script change serializes resource test files only.
Actual GitHub CI evidence for the new commit is attached separately to PR #13;
the baseline's earlier green CI is not reused as evidence for this correction.

The initial negative test attempted `SET LOCAL ROLE app_user` in the migration
connection. Its first full replay and focused diagnostic failed: Neon rejected
that role switch (`42501`), before the helper was exercised. Those failures are
not PASS evidence. The test now uses the real runtime connection and does not
grant role membership or weaken the expected helper-specific denial.
No live external provider calls or Production mutation are authorized by this
certification. Local table-fixture grants are existing test bootstrap mechanics;
they are not a Production privilege prescription.

Cleanup: allow the dedicated certification branch to expire automatically; never
reset, modify or delete its Production source branch.
