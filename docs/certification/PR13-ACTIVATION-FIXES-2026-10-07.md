# PR13 activation fixes — isolated certification

This follows the failed activation recorded in PR13-PRODUCTION-ACTIVATION-2026-10-07.md.
That historical failure is not overwritten or presented as a successful deployment.

## Corrections

- Remove only the public-schema future-table defaults granting app_user automatic DML.
  Existing table/function ACLs must remain unchanged. Global function defaults remain hardened.
- Each pending Resources/SoD/Reviews migration revokes inherited app_user privileges on
  its new tables before granting the minimum required privileges. Existing tables are untouched.
- An explicit, audited `native-role:LUXIA_ORG_ADMIN:v2` extension adds only `sod.read`,
  `sod.manage`, `access_reviews.read`, `access_reviews.create`, `access_reviews.decide`,
  `access_reviews.manage` to the real canonical Subject in its existing tenant.
  Login and migrations never apply this bundle. The original 15 assignments remain intact.
  Replay is idempotent; rollback revokes only these six assignments and preserves audit history.
- Dashboard metrics and activity use permission-gated tenant database queries. Invented
  health, recommendations and activity are removed. Menus require active native unbound
  entitlements, not legacy roles. Read-only context indicators cannot pretend to switch tenants.
- `vercel.json` disables automatic Git deployments of main, leaving previews unchanged.
  Production activation must explicitly deploy the exact merge SHA after its CI passes;
  a merge cannot silently publish before the gate finishes.

## Isolated database provenance

- Neon project: `hidden-leaf-91460552`.
- Clone: `br-steep-morning-ahsjmlye`, parent `br-billowing-frog-ahtirmax`.
- Expiration: `2026-10-09T20:24:35Z`.
- Copied Production database: `neondb`; empty fixture database: `luxia_reviews_cert`.
- Production candidate migrations were not applied when this document was created.
- Providers PR12 remains excluded and Draft. No live provider certification was executed.

## Completed copied-schema SQL evidence

`certify-global-function-acl.cjs` passed on the copied neondb, migrating the actual 15-migration
baseline to 18 without manual schema repair. Creator/session role was neondb_owner.
Existing function ACLs and invalid resolve_session behavior were unchanged. The temporary
probe denied PUBLIC/app_user EXECUTE and allowed owner EXECUTE; it was removed afterward.

All three candidate functions deny PUBLIC EXECUTE. app_user can execute only
luxia_sod_scope_contains; trigger entry points have no runtime EXECUTE grant.
All six new tables have RLS enabled/forced and no runtime ownership. Scopes/members permit
SELECT/INSERT only; policies/rules/review campaigns/items permit SELECT/INSERT/UPDATE only.
No new table grants runtime DELETE.

The empty fixture runner grants broader DML for test fixture setup; its grants do not
constitute Production least-privilege evidence. The copied neondb matrix above is separate.

## Activation still gated

The full local runner completed successfully: PostgreSQL Resources/SoD/Reviews,
existing security, provider contracts, identity, operations, operational certification,
cutover readiness, TypeScript, lint and local production build. No live provider was called.
The copied database's existing table ACLs were separately compared unchanged, and its
new table RLS flags/runtime role posture were explicitly checked.

The latest focused PostgreSQL bundle test passed, including grant/replay/rollback/replay
and wrong-tenant/retired-subject denial. The copied real Subject's plan, explicit grant,
grant replay, rollback and rollback replay each passed using app_user. The rollback test
compares assignment ID sets, not an unspecified SQL row order. A final TypeScript check
and 13 dashboard/architecture assertions also passed.

A read-only direct Production app_user check passed NOSUPERUSER/NOBYPASSRLS and the
invalid-session resolve_session call. This is not a claim that a new Vercel deployment
has been verified; no replacement deployment exists yet.

Local full-suite, explicit real-Subject bundle/rollback, exact new candidate CI, Production
preservation checks and authenticated Production smoke must be recorded separately when
actually completed. No GO-LIVE approval is implied by this document or a READY deployment.

Production restore reference remains `br-aged-paper-ahx2qmi3`, LSN `0/2EDA4F8`, expiring
2026-10-14T20:11:27Z. Known-good application rollback target remains
`dpl_ExBwb9M9RTqsqWwrR4sfWa8E6GL4`, SHA `07bbd51693949d06994b20e2aa1ee25e46e1d17b`.
Do not restore database data blindly: later writes must be preserved and assessed.
