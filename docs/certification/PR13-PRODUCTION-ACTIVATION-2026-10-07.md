# PR13 Production activation — STOP before candidate migrations

## Exact provenance

- Candidate PR13: `c991c06e802fab4458fafccf8e0407f964d1e134`, still Draft.
- Current Production SHA: `07bbd51693949d06994b20e2aa1ee25e46e1d17b`.
- Current / rollback deployment: `dpl_ExBwb9M9RTqsqWwrR4sfWa8E6GL4`.
- Immutable deployment: `https://iam-azure-qv5dquwbp-legrandborisohandjaedimo-4025s-projects.vercel.app`.
- Vercel project: `prj_dZ6YOYRdONsicgWdlmofh7NwtoSP`, target Production, READY.
- Production Neon project/branch/database: `hidden-leaf-91460552` /
  `br-billowing-frog-ahtirmax` / `neondb`.
- PR12 remains unrelated; no provider certification or provider changes.

## Authorized step actually committed

The separately certified global default-function hardening was applied on the
exact Production admin connection, with current_user/session_user checked as
`neondb_owner`:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner
REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```

Post-commit global function ACL: `{neondb_owner=X/neondb_owner}`. No explicit
function default ACL reintroduces PUBLIC EXECUTE for this creator. Existing
public function ACLs/bodies were compared unchanged, resolve_session's invalid
session result was unchanged, and identity/provider/legacy row digests were
compared unchanged within the transaction. No Production probe function was
created and no existing runtime privilege was revoked.

The earlier clone PASS was a function-EXECUTE hardening certification. It did
not establish that all future-table privileges were minimal; the additional
table-privilege gate below now explicitly fails.

## Restore point and application rollback

- Backup branch: `br-aged-paper-ahx2qmi3`.
- Name: `backup-pr13-production-20261007`.
- Parent: exact Production branch, LSN `0/2EDA4F8`.
- Created: `2026-10-07T20:11:33Z`, after function hardening and before any candidate migration.
- Expiration: `2026-10-14T20:11:27Z`.
- Read-only connection validation: PASS, 15 applied migrations, 1 Subject, 2 IdentityAccounts.
- Existing Production HTTP: login 200; unauthenticated dashboard 307 to login;
  canonical resource endpoint 401.
- Application rollback command, only if an actual deployment requires rollback:
  `vercel rollback dpl_ExBwb9M9RTqsqWwrR4sfWa8E6GL4 --yes --scope legrandborisohandjaedimo-4025s-projects`.
- Database restore syntax is available through Neon branches restore. Restoring
  Production to the backup would replace current data, losing subsequent writes;
  use only for demonstrated DB damage, preserve the incident branch, and validate
  connections/session posture afterward. No database restore was executed.
- No new deployment exists in this activation; no application rollback is required.

## Failed least-privilege gate

Production pg_default_acl contains an existing public-schema table default:
`{app_user=arwd/neondb_owner}`. It automatically grants SELECT, INSERT, UPDATE and
DELETE on future tables created by neondb_owner.

Read-only inspection of the faithful certification clone's copied `neondb`,
after its candidate migrations but without the broad empty-fixture DB grants,
confirms all four privileges on each of:

- ResourceScope
- ResourceScopeMember
- SoDPolicy
- SoDRule
- AccessReviewCampaign
- AccessReviewItem

This exceeds the explicit grants in the candidate migrations: scopes need only
SELECT/INSERT; SoD and review tables grant SELECT/INSERT/UPDATE, not DELETE.
RLS and immutable triggers do not make unnecessary SQL privileges least-privilege.
Do not bypass the failed gate or silently mark PASS.

Recommended separate correction: certify removal of the creator's public-schema
future-table app_user defaults on a faithful clone, leaving existing table ACLs
unchanged; then rely on the explicit grants of the three migrations. If the
functions perform security checks that require additional privileges, test those
individually rather than retaining global automatic DML. This change has NOT
been applied to Production in this activation.

## Additional visible-product gaps

The real active Subject has the existing 15 native admin entitlements, including
resources.read/manage. It has no sod.read/manage or access_reviews.* grants.
The candidate sidebar correctly hides those pages. No governance entitlement
or Assignment was automatically created; a separate explicit tenant-scoped
bundle upgrade is required to make those tools usable by this administrator.

`app/dashboard/page.tsx` also still has hard-coded service health, recommendation
counts and recent activity. The headline metrics fetch `/api/dashboard`, but
these other panels are not real operational evidence. They must not be certified
as a fully real-data dashboard. No unrelated UI change was smuggled into the
frozen candidate during activation.

Vercel DATABASE_URL is configured as sensitive. The read-only API exposes its
name and metadata, not its value; no secret was extracted or logged. Actual
deployment runtime-role certification still requires authenticated runtime
evidence, not an assumption from the admin connection.

## Final result

- Function default hardening: PASS, committed.
- Backup readable: PASS.
- Future-table runtime least privilege: FAIL.
- Candidate migrations in Production: NOT APPLIED (still 15 migrations).
- Existing identities/permissions/legacy/provider changes: NONE from this activation.
- PR13 Ready for Review / merge / main CI / new deployment: NOT EXECUTED.
- Authenticated Resources/SoD/Access Reviews/passkey/JML smoke: NOT EXECUTED.
- Visible governance administration for the real user: BLOCKED by missing canonical grants.
- Real-data dashboard certification: FAIL for hard-coded operational panels.
- Production GO-LIVE for Resources & Governance: NOT APPROVED.

No next feature is started. Stop preserves the currently serving application and
the separately approved security hardening, without pretending activation completed.
