# Migration `20261011180000_organization_status_session_scope`: rehearsal, Production and rollback

Design (approved, M1 to M6 and A1 to A5): `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-MIGRATION-DESIGN.md`.

The migration is expand-only. The application deployed before it (`ebb4f46`) keeps working unchanged, and no deployment is needed to apply it. The only Production change is the database migration itself, so it needs the operator's explicit approval.

## 1. Rehearsal on an isolated clone (before any Production action)

1. **Clone.** Create a Neon branch from Production. Use only its direct owner endpoint, never Production.
2. **Before:** `scripts/certification/organization-status-business-digest.sql`. Also record the function and trigger definitions, and the sessions that resolve through `resolve_session`.
3. **Apply** with `prisma migrate deploy` (owner, direct endpoint), exactly as in Production. Prisma applies the file as one transaction.
4. **After:**
   - the digest is identical (the new columns are removed from each row);
   - every organization is ACTIVE with `statusChangedAt` NULL;
   - every session is FULL;
   - the same open sessions resolve through both resolvers;
   - the runtime grants are in place: `app_user` executes `resolve_session`, `luxia_session_resolve` and `luxia_organization_lock_active`.
5. **Behavior on the clone** (never in Production):
   - backfill, constraints and transitions;
   - existing sessions;
   - SUSPENDED and CLOSED refused at resolution and at sign-in;
   - append-only sessions;
   - one race (sign-in against a transition).
6. **Rollback** (`docs/operations/ORGANIZATION-STATUS-SESSION-SCOPE-ROLLBACK.sql`, `psql -1`, owner). Do it on a second clone, or on the same clone before any status is changed:
   - the digest is identical to step 2;
   - the definitions are identical, apart from line endings;
   - the migration then applies again.
7. **Report** to the operator, then delete the clones.

## 2. Production (after explicit approval, exact SHA with CI PASS)

1. **Backup:** a Neon branch of Production just before the migration.
2. **Before:** the digest and the migration list (20 applied).
3. `prisma migrate deploy` with the owner, on the direct endpoint, with `lock_timeout` at 5 s. If the lock is not obtained, the migration fails cleanly and is retried.
4. **After:**
   - the digest is identical;
   - 21 migrations applied;
   - both organizations ACTIVE;
   - Legrand Tech's open sessions still resolve;
   - a new sign-in works (one human action);
   - the grants are in place.
5. **No deployment.** B3 is built and approved separately.

## 3. Rollback

- **Application:** nothing to roll back. The deployed code does not depend on the migration.
- **Database:** the rollback script above, as the owner, in one transaction. It refuses as soon as an organization is not ACTIVE, or a RECOVERY session exists. After that point, the only path is a forward fix. Restoring the backup branch is the last resort.
