# Customer Self-Onboarding v1: migration, rollback and forward-fix

Migration: `prisma/migrations/20261011000000_customer_self_onboarding_v1/migration.sql`.
Scope: `docs/product/CUSTOMER-SELF-ONBOARDING-V1-SCOPE.md`, sections 9 and 10.

**No Production migration without review, CI on the exact SHA, and the operator's explicit approval.**

## What the migration does

| Change | Detail |
|---|---|
| `Organization.slug` | Added as a nullable column. Then the explicit backfill runs: `4841428a-80b4-4f07-bb3f-c94612dfd4a2` (Legrand Tech) gets `legrand-tech`, and any other existing organization gets a random `org-…` slug. After that, the column gets its default, `NOT NULL`, a unique index, a format check (3 to 40 characters, `a-z 0-9 -`, no `--`) and the `organization_slug_immutable` trigger. No other column or row is written, and `updatedAt` is untouched. |
| `SignupCode` | Code hash (64 hex), status, expiry (30 days max), reservation, consumption and revocation. Rows can't be deleted, and terminal states are final (trigger). |
| `OrganizationDomain` | Normalized domain, challenge hash, status, expiry. A partial unique index on verified domains applies across **all** organizations. The domain can't be renamed, and rows can't be deleted. |
| `Invitation` | Token hash and role. The expiry is set by the database (`createdAt + 7 days`) and can't be changed. Tenant, person, role, token and inviter are immutable. Accepted or revoked is final, and acceptance after expiry is refused. Only one open invitation per person. |
| `RateLimitBucket`, `RateLimitConfig` | Peppered key hashes and a single random pepper. |
| RLS | Forced on all five tables. The two tenant tables get the standard tenant policy. The three internal tables get **no policy**, and app_user has no privilege on them. |
| Functions | Trigger guards: `luxia_organization_slug_guard`, `luxia_signup_code_guard`, `luxia_invitation_guard`, `luxia_organization_domain_guard`. These are owner only. Runtime entry points: `luxia_rate_limit_hit`, `luxia_signup_reserve`, `luxia_signup_consume`, `luxia_invitation_resolve`, `luxia_login_decoy`. These are `SECURITY DEFINER` with a pinned `search_path`, PUBLIC is revoked, and only `app_user` gets EXECUTE. They accept hashes only. |
| Grants | app_user gets `SELECT, INSERT, UPDATE` on `OrganizationDomain` and `Invitation` (no `DELETE`), and EXECUTE on the five runtime functions. Nothing else changes. |

## Pre-flight (Production, read-only)

1. `_prisma_migrations` ends with `20261008040000_resource_onboarding_evidence`.
2. There is exactly one organization, `4841428a-80b4-4f07-bb3f-c94612dfd4a2` / `Legrand Tech`.
3. The owner role has `BYPASSRLS`, which is required for the definer functions. On 2026-10-11, `neondb_owner` was observed with `rolbypassrls = true`.
4. Run `scripts/certification/self-onboarding-business-digest.sql` as the owner in a `READ ONLY` transaction and keep the output as **digest A**.

## Post-migration verification

1. Running the digest again gives **digest B**. It must equal digest A exactly; the `Organization` row is hashed without `slug`.
2. `SELECT slug FROM "Organization"` returns `legrand-tech`.
3. The function privilege gate holds, as in `tests/resources/function-privileges.test.ts`.
4. Smoke test: Legrand Tech sign-in still works with Microsoft and with a passkey.

## Rollback

The migration is additive. The application code released before this slice does not read the new column or tables. The first option is therefore **to roll back the application, not the schema**: redeploy the previous Production deployment, and leave the schema in place.

If the schema itself must be removed (an operator decision, after a digest), run this as the owner in one transaction, and only if no customer data was created in the new tables:

```sql
BEGIN;
-- Refuse if any onboarding data exists.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "SignupCode") OR EXISTS (SELECT 1 FROM "Invitation") OR EXISTS (SELECT 1 FROM "OrganizationDomain")
     OR (SELECT count(*) FROM "Organization") <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED_DATA_EXISTS';
  END IF;
END $$;
DROP TABLE "Invitation", "OrganizationDomain", "SignupCode", "RateLimitBucket", "RateLimitConfig";
DROP FUNCTION luxia_rate_limit_hit(TEXT, TEXT, INTEGER, INTEGER), luxia_signup_reserve(TEXT, TEXT, JSONB, INTEGER),
  luxia_signup_consume(TEXT, TEXT), luxia_invitation_resolve(TEXT), luxia_login_decoy(TEXT),
  luxia_signup_code_guard(), luxia_invitation_guard(), luxia_organization_domain_guard();
DROP TRIGGER organization_slug_immutable ON "Organization";
DROP FUNCTION luxia_organization_slug_guard();
ALTER TABLE "Organization" DROP CONSTRAINT "Organization_slug_format";
DROP INDEX "Organization_slug_key";
ALTER TABLE "Organization" DROP COLUMN "slug";
DROP TYPE "SignupCodeStatus", "OrganizationDomainStatus", "InvitationRole";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261011000000_customer_self_onboarding_v1';
COMMIT;
```

Once a second organization, an invitation or a verified domain exists, **do not drop anything**. Use a forward fix instead.

## Forward-fix

- Never edit an applied migration. Add a new, reviewed migration with its own tests.
- **Slug change** (requirement 4): this is not a v1 feature. A future change is an explicit operator procedure in a dedicated migration that disables `organization_slug_immutable` for one `UPDATE`, re-enables it in the same transaction, and writes an audit event in the organization's journal. A slug is never reassigned to another organization.
- **Abused or leaked signup code**: as the owner, set `status = 'REVOKED'`, `revokedAt = now()` and `revokedBy`, and clear the `pending*` fields. The trigger keeps the change final.
- **Invitation sent to the wrong person**: an admin revokes it in the product, which sets `revokedAt`. Rows are never deleted.
- **Rate-limit pepper**: rotating it resets the counters and changes the sign-in decoys. As the owner, run `UPDATE "RateLimitConfig" SET pepper = <new 64-hex>`.
