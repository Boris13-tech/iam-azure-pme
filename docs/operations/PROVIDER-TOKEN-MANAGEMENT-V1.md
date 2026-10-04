# Provider Credential & Token Management v1

Status: controlled certification PASS; GitHub CI is a separate final gate.
No real provider calls. No Production changes.

## Implemented, controlled tests only

`ProviderTokenManager` exposes acquire, getValidToken, invalidate,
rotateCredential and executeWithToken. Cache isolation includes organization,
tenant, connection, provider type, credential version and authentication strategy.
Tokens exist only in process memory; expiry derives from provider expires_in,
with a central configurable safety margin. Concurrent acquisition shares a flight;
failure releases it. Invalidation fences in-flight acquisitions. A 401 allows one
reacquisition and one retry; a second 401 terminates. A 403 is classified as scope
insufficient, not assumed to be consent missing or expired credentials.

The Entra acquirer uses client_credentials and Graph .default, bounds response
size, forbids redirects, sanitizes failures, and rejects refresh tokens and absent
expiry. Google strategies are contracts only, not an arbitrarily selected strategy.
OIDC metadata testing remains unchanged and requires no token acquisition.

Rotation tests candidate N+1 before custody compare-and-swap. Failed candidate
testing preserves N. Successful activation invalidates all connection cache
versions immediately. Retirement of N is a separate custody operation.

## Scoped custody and canonical audit integration

`createScopedTokenStore` now implements the PostgreSQL/RLS scope boundary and
versioned secret resolution. `createVersionedEntraDriver` is the explicit opt-in
management integration. Existing unversioned management and OIDC login routes
are not cut over by this change. Google strategies remain contracts; Generic
OIDC public metadata never acquires a token.

- authorize verifies Organization, Tenant, scoped ProviderConnection,
  management enabled, active/pending credential version and exact secret reference
  before any custody lookup;
- audit persists tenant-scoped CanonicalAdminAuditEvent using app_user;
- activateCredential atomically compares-and-swaps the active version, paired
  with its canonical rotation audit in the same transaction;
- revoke commits the revoked state and canonical revocation event atomically,
  then invalidates memory. Control events are idempotent per actor/connection/version;
- rotation distinguishes active from pending credential versions without
  copying credential material to PostgreSQL;
- cache hits revalidate enabled/revoked/version/scope. The invalidation API covers
  disable/delete/scope removal and explicit security signals;
- audit metadata has an exact allowlist with contextual equality checks and fixed
  reason/error code enums. Wrong-version/disabled/revoked denials commit before
  the service throws. Cross-tenant mismatches do not expose provider information.

## Metadata migration and secret references

The additive migration `20261004090000_provider_credential_versions` adds only
activeCredentialVersion, candidateCredentialVersion and credentialRevoked to
ProviderConnectionTenantScope. Existing ENABLE/FORCE RLS and composite FKs are
retained. A CHECK enforces version syntax and distinct active/candidate values.
There is no invented version/backfill of existing connections.

credentialSecretRef remains the exact connection-scoped anchor. The actual
custody key is derived from organization/tenant/connection/providerType/version.
No credential material, access token or refresh token is stored in PostgreSQL.
Credential versions must be provisioned with their scoped custody keys before
use; existing unversioned credentials are never silently reinterpreted.

## Validation

Tests use real isolated PostgreSQL with app_user for runtime checks and owner
only for controlled fixture creation/cleanup. OAuth and Graph responses are
mocked; no real provider is contacted. The full CI-equivalent run and GitHub CI
are separate gates, not substitutes for future live-provider certification.

The Entra live runner remains BLOCKED. Operator credentials, consent and
certification sessions are independent prerequisites; token-manager readiness
never grants permission to execute a live provider. PR #12 remains Draft.

## Controlled evidence (2026-10-04)

- Neon project hidden-leaf-91460552, isolated branch br-orange-bird-ahnxdefk,
  database luxia_provider_cert; no Production connection used.
- 17 migrations applied; app_user NOSUPERUSER/NOBYPASSRLS, no ownership or
  administrative memberships. Existing scope/audit RLS ENABLED and FORCED.
- Versioned custody PostgreSQL/RLS: 13 controlled cases PASS, including committed
  SUCCESS/FAILURE/DENIED audits, wrong scope/version/provider/disabled/revoked
  denial before custody/network, rotation, revocation and controlled OAuth/401.
- Provider adapters: 180 tests PASS. Existing security, identity, operations,
  operational certification and Entra parity suites PASS.
- TypeScript, lint, production build and cutover readiness PASS against the
  isolated runtime connection; git diff --check PASS.
- Canonical identity and legacy inventory unchanged by token-store operations.
  Controlled token/secret markers absent from DB metadata/audits/logs.
- The two historical root *.test.ts files are standalone scripts without Vitest
  suites, already excluded from configured CI. Invoking them as Vitest yielded
  0-test failures; they were not rewritten or represented as passing suites.
  A scoped post-check found no leftover organizations/users from that invocation.

This certifies the explicitly versioned backend entry point, not a production
cutover of unversioned drivers or an Entra/Google/OIDC live connection. Live Entra
still requires a separately prepared, versioned dedicated main/NO_CONSENT setup;
the runner hard-stop prevents the old unversioned live path from being used.
