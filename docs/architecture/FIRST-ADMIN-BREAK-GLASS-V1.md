# First Admin / Break-glass v1: implementation notes

Scope and decisions: `docs/product/FIRST-ADMIN-BREAK-GLASS-V1-SCOPE.md` (K1 to K5 approved). This file records how each part is built, one section per part.

## B1, last-administrator guard (no migration)

**Rule.** A change is refused with `LAST_ADMINISTRATOR_PROTECTED` (409) when the tenant has at least one active administrator before it and none after it. A tenant that already has none is not blocked, so unrelated work can continue there; restoring an administrator in that case is the job of B2 and B4.

**Who counts as an active administrator** (`lib/admin/last-administrator.ts`, one definition also used by the "second administrator" item of the checklist):
- a `HUMAN` subject in the `ACTIVE` lifecycle;
- with at least one `ACTIVE` identity account, because a person who cannot sign in cannot administer;
- holding an `assignments.manage` grant that is native (not `LEGACY_ROLE`, as in `requireNative`), already effective, and **without an end date**.

A grant with an end date does not count. Otherwise a temporary administrator could remove the last permanent one, and the tenant would be left with no administrator when that grant expires, with no action anyone could refuse.

**Mechanism.** All of it runs in the transaction of the change.
1. `pg_advisory_xact_lock` on `administrators:<organization>:<tenant>`. In the canonical operations this lock is taken before any read.
2. The guard counts the administrators, sets a savepoint, applies the change, then counts again. Under READ COMMITTED, counts read after the lock include every change committed by an earlier holder. Two concurrent removals therefore cannot both pass.
3. On refusal, the guard rolls back to the savepoint. The DENIED event is then written and committed in the same transaction (`<OPERATION>.DENIED`, `reasonCode: LAST_ADMINISTRATOR_PROTECTED`, the actor and the target), and nothing else of the change remains.

**Paths covered.**

| Path | Can it remove an administrator? | Guard |
|---|---|---|
| Disable an identity account (`IDENTITY_ACCOUNT.DISABLE`) | Yes | Lock, then guard, then audited refusal |
| Change a lifecycle away from ACTIVE (`SUBJECT.UPDATE`: suspended, disabled, recovery required, retired; DISABLED and RETIRED also revoke every grant) | Yes | Lock, then guard, then audited refusal |
| Revoke a catalog grant (`ASSIGNMENT.REVOKE`) | Yes | Lock, then guard, then audited refusal |
| Revoke or update a resource grant, revoke a resource entitlement | No: resource-scoped only | Guard as defense in depth; the refusal is audited by `operation()` |
| Access review REVOKE decision | No: review items hold resource grants only | Guard as defense in depth; refusal audited |
| Roll back the v2 governance bundle | No: the bundle does not contain `assignments.manage` | Guard as defense in depth |
| Legacy dual write (`app/api/users`) | No: it revokes `LEGACY_ROLE` grants only | Reviewed, not guarded |
| Accept an invitation | No: it only activates | Reviewed, not guarded |

`tests/security/last-administrator-architecture.test.ts` fails as soon as a new writer of subjects, identity accounts, grants or entitlements appears in `lib/` or `app/` without being guarded or reviewed in that test.

**Out of B1 scope:**
- A lost passkey or a locked local identity does not change the count. Recovery codes (B2) handle that case.
- Operator scripts under `scripts/` act outside the product. B4 replaces them with closed actions.

**Tests:**
- `tests/resources/last-administrator-postgres.test.ts` runs on PostgreSQL as `app_user`. It covers:
  - each direct removal of the only administrator is refused, audited, and leaves the subject, account, sessions and grants unchanged;
  - one of two administrators can be removed, never the last;
  - the counting rules (temporary, future, legacy, no account, service);
  - a tenant already without an administrator is not frozen;
  - four concurrent pair scenarios and one three-way scenario. Every operation is queued on the lock before it is released, and exactly one of the last removals is refused;
  - resource governance and the bundle cannot reach `assignments.manage`;
  - the savepoint rollback keeps the rest of the transaction.
- `tests/security/canonical-administration-v1.test.ts` covers the refusal path: the savepoint is rolled back and the DENIED event is written.
