# Providers Management v1 — Live Certification Setup

Status: DATABASE AND SECRET STORE PROVISIONED; EXTERNAL PROVIDERS BLOCKED. Date: 2026-10-03.
PR #12 remains draft. No Production writes, provider calls or consent changes.

## Executed setup evidence (supersedes initial prerequisites below)

- PR head verified: `a7818a7ce08bcd33dd8cc4525d996f91087824c0`, draft.
- Authenticated Neon CLI OAuth account is available.
- Project `hidden-leaf-91460552`; verified default source `br-billowing-frog-ahtirmax`.
- Created `providers-live-cert-20261003`, ID `br-orange-bird-ahnxdefk`,
  `init_source=parent-schema`, not a Production row clone.
- Native automatic expiry: `2026-10-05T20:16:45Z`.
- Dedicated blank database `luxia_provider_cert` created in the child and all
  16 repository migrations applied successfully from scratch. The cloned schema
  database is not used for certification; no copied business rows are used.
- Four scoped tables verified ENABLE and FORCE RLS. Runtime `app_user`
  verified NOSUPERUSER/NOBYPASSRLS, no administrative memberships/ownership,
  `resolve_session(text)` EXECUTE. Child password rotated only in the child.
- Provider management real-Neon RLS suite PASS, including scope FK denial,
  cross-tenant access, replay/conflict, zero dry-run identity mutations,
  collision quarantine/rejection and canonical audit. Provider responses in this
  suite are fixtures, NOT evidence of live Graph/Directory connectivity.
- Initial test run failed with local timeout settings; repeat with 30-second
  test/hook bounds passed. No RLS bypass was added to runtime.
- GitHub Environment `provider-certification` created with custom deployment
  branch policy allowing only `feat/providers-management-v1`.
- Stored only child database credentials as environment secrets
  `LUXIA_CERT_DATABASE_URL` and `LUXIA_CERT_DATABASE_MIGRATION_URL`.
  No secret values emitted. No external provider credentials are present.
- Local administrative helper refuses any other hostname/database and does not
  print raw SQL/provider diagnostics or test logs.
- Cleanup: Neon automatic expiration deletes the child branch and dedicated
  database; remove its two GitHub DB secrets after expiration, revoke dedicated
  external test credentials when added, retain only nonsecret evidence.

No merge, Production deployment or live provider call was performed.

## Isolation and database provisioning gate

Create a **schema-only** Neon branch from the verified current Production parent,
not a data clone subsequently scrubbed. Proposed branch name:
`cert-providers-v1-20261003`. Set native Neon automatic expiration to 48 hours
after creation and verify the returned expiration timestamp. Do not create an
unexpiring fallback. Record project ID, actual parent branch ID, creation time,
schema fingerprint and child branch ID in the certification report, not credentials.
Historical IDs from chat are not sufficient proof of the current parent.

Initial console automation failed; authenticated CLI access was subsequently
discovered and used as recorded above.

Before enabling the certification runtime:

1. Verify schema-only creation, zero business rows (including legacy tables),
   and no copied credential material in any table. Inspect migration history:
   schema-only may omit migration bookkeeping; reconcile against the parent
   migration inventory before applying PR migrations. Do not replay existing
   DDL blindly or mark an unverified migration applied.
2. Apply only reviewed pending migrations on the child using its migration role.
3. Create/verify child-only runtime credentials: `app_user` NOSUPERUSER,
   NOBYPASSRLS, no administrative ownership; verify forced RLS, tenant policies
   and `resolve_session` with the runtime connection.
4. Never reuse copied Production role passwords. Rotate child runtime and admin
   passwords without changing the parent. Stop if credential isolation cannot
   be demonstrated.
5. Seed only explicitly designated certification Organization/Tenants and test
   Subjects needed for authenticated API tests, not real customer identities.
   Each provider gets a separate tenant and ProviderConnection. Include a second
   tenant for denial tests. Record these seed rows separately from discovery:
   every discovery dry-run must create zero Subject/IdentityAccount rows.
6. Use a dedicated server-only certification runtime/secret store, not Vercel
   Production or a shared Preview environment. Runtime receives only pooled
   child `DATABASE_URL`; migration credential stays outside application runtime.

READY requires actual branch, automatic expiry, blank-data and runtime RLS
evidence. A document or local mock database is not READY.

## Names-only configuration inventory

Control-plane setup (not application runtime):

```text
LUXIA_CERT_NEON_API_KEY
LUXIA_CERT_NEON_PROJECT_ID
LUXIA_CERT_NEON_PARENT_BRANCH_ID
LUXIA_CERT_NEON_BRANCH_ID
LUXIA_CERT_NEON_EXPIRES_AT
LUXIA_CERT_DATABASE_URL
LUXIA_CERT_DATABASE_MIGRATION_URL
```

Dedicated Entra profile:

```text
LUXIA_CERT_ENTRA_TENANT_ID
LUXIA_CERT_ENTRA_CLIENT_ID
LUXIA_CERT_ENTRA_CLIENT_SECRET
LUXIA_CERT_ENTRA_NO_CONSENT_CLIENT_ID
LUXIA_CERT_ENTRA_NO_CONSENT_CLIENT_SECRET
```

Dedicated Google profile:

```text
LUXIA_CERT_GOOGLE_PROJECT_ID
LUXIA_CERT_GOOGLE_CUSTOMER_ID
LUXIA_CERT_GOOGLE_CLIENT_ID
LUXIA_CERT_GOOGLE_CLIENT_SECRET
LUXIA_CERT_GOOGLE_REFRESH_TOKEN
LUXIA_CERT_GOOGLE_CREDENTIAL_JSON
LUXIA_CERT_GOOGLE_ACCESS_TOKEN
```

Google OAuth and service-account JSON are alternative custody profiles, not
credentials to populate simultaneously. The existing driver consumes a short-lived
**access token**, not credential JSON or a refresh token. A secure external broker
must supply that token; do not claim automatic refresh or JSON support exists.

OIDC profile and actual server runtime names:

```text
LUXIA_CERT_OIDC_ISSUER
LUXIA_OIDC_ALLOWED_ISSUERS
DATABASE_URL
LUXIA_PROVIDER_<CONNECTION_SCOPE_SHA256>
```

These are planned input names; `LUXIA_CERT_*` are not automatically consumed by
the existing application. Never use `NEXT_PUBLIC_*` for credentials.

## Secret-reference binding: existing implementation, no new resolver

For each actual certification connection, invoke `connectionSecretReference`
from `lib/provider-management/contracts.ts` using its Organization/Tenant/
ProviderConnection IDs. Its output is `LUXIA_PROVIDER_` plus uppercase SHA-256
of the JSON array of those three IDs. Store only that reference in
`credentialSecretRef`.

The secure server runtime injects the Entra client secret or Google access token
under the derived name. Do not store the credential value in configuration,
metadata, audit, fixtures, screenshots or Git. Generic OIDC metadata requires
no credential: its reference remains null. Different scopes must yield distinct
references; the wrong-scope reference is rejected before external calls.

Choose and verify an actual secure store before declaring Secret storage PASS:
access restrictions, server-only injection, audit permissions, redaction and
credential expiry/revocation. None has been provisioned/verified in this task.

## Entra certification profile

Use a dedicated non-Production tenant and single-tenant App Registration.
For the current `/v1.0/users` app-only driver, request only Graph application
`User.Read.All`, with explicit tenant administrator consent. No directory write,
group write or broad `Directory.Read.All` permission is needed for this slice.
Use a distinct no-consent application for the negative case; never revoke
Production permissions. Connection `externalScopeId` is the certification
Directory ID; configuration `clientId` is the dedicated application ID.

Current driver supports client-secret authentication, not certificate assertion.
If certificate custody is mandatory, stop rather than fabricate support.
The certification needs no production OIDC redirect URI: it tests Graph
client-credentials connection/discovery, not interactive sign-in.

## Google certification profile

Use a dedicated Cloud project and a dedicated Workspace test customer/domain.
Enable Admin SDK Directory API. Restrict authorization to
`https://www.googleapis.com/auth/admin.directory.user.readonly` and user-read
administrative privileges. If domain-wide delegation is selected, a Workspace
administrator must explicitly approve that scope/client; it is not implied by
enabling the API. Keep JSON/private keys and OAuth refresh material in the secure
broker/store only. Supply a short-lived token to the existing driver.

Connection `externalScopeId` and configuration `customerId` must match the
explicit certification customer ID. Use a dedicated revocable credential for
negative tests. No access to customer Production directories is acceptable.

## Generic OIDC certification profile

An exact public HTTPS issuer must be explicitly approved by the operator before
any retrieval. Do not infer approval from known providers or choose an issuer.
Set the same issuer in external scope, configuration, and certification-only
`LUXIA_OIDC_ALLOWED_ISSUERS`. Require exact metadata issuer match; reject IP
literals, local/private DNS answers and redirects. Current public transport is
IPv4-only and fails closed for IPv6-only resolution. No user enumeration.

## Execution hold and evidence

### Prepared runner entry points

```text
npx tsx scripts/provider-certification/entra.ts
npx tsx scripts/provider-certification/google.ts
npx tsx scripts/provider-certification/oidc.ts
```

These require secure process injection, never environment files or command-line
secret values. They require a preprovisioned dedicated certification scope for
each provider, configured through the existing canonical rules. Scope identifiers
are inputs `LUXIA_CERT_<PROFILE>_ORGANIZATION_ID`, `_TENANT_SCOPE_ID`,
`_ACTOR_SUBJECT_ID`, `_CONNECTION_ID`; the external Entra tenant ID is separate.
Verified operator consent is recorded as `LUXIA_CERT_ENTRA_CONSENT_CONFIRMED`
or `LUXIA_CERT_GOOGLE_CONSENT_CONFIRMED`; issuer approval is
`LUXIA_CERT_OIDC_APPROVED`. These flags do not prove external consent by themselves.
Google's negative case needs `LUXIA_CERT_GOOGLE_REVOKED_ACCESS_TOKEN`.

Preflight checks missing names without exposing values and refuses any database
outside the recorded certification endpoint/database. Existing connection type,
external scope/configuration and derived secret reference are checked before
network access. Runtime is app_user, not the fixture owner. Each runner now
maintains a required-gate ledger; omitted, blocked or unexecuted gates cannot
yield PASS. Exit 2 means BLOCKED, exit 1 FAIL, exit 0 all profile gates passed.
This is executable coverage, not evidence of completed live certification.

Audit rejection is a mandatory ledger gate. Code review originally found that
`runProviderOperation` throws `PROVIDER_DISABLED` before recording an operation
event, while the HTTP error facade only returns the safe error. The runner now
checks for a non-success event with the rejected operation's changeId and blocks
certification if absent. The gap is now corrected with a committed transaction
sentinel in the product service (see PROVIDER-DENIAL-AUDIT-V1.md); the runner
fails when the actual DENIED event is absent, never fabricates evidence.

Entra/Google perform real connection and discovery, invalid-credential requests,
then a dedicated no-consent application or revoked Google credential request.
Returned IDs are compared with raw provider IDs captured in memory. Live
pagination requires at least two real Directory pages; fewer pages produce
BLOCKED rather than a fabricated pagination PASS. Bounds 1000/10 pages are also
verified in the controlled transport suite. A duplicate of an actual live
projection is deliberately reinjected to verify real Neon quarantine and
rejection; this is labeled CONTROLLED_DUPLICATE_NEON, not a claim the provider
emitted duplicate IDs. OIDC calls only the approved live metadata endpoint;
unsafe-address, redirect and issuer-mismatch attacks run in the mocked transport
suite and are labeled CONTROLLED_TRANSPORT, not calls to unapproved issuers.

Cross-tenant factory-not-called denial, incorrect secret reference, idempotent
replay and conflicting reuse, disabled operations, audit success/failure and
collision rejection are checked against Neon. Full-row before/after inventories
cover Subject, IdentityAccount, User, Role, Permission, UserRole, RolePermission,
AccessPolicy, AuditLog and LegacyUserBridge. No legacy role transfer is performed.

HTTP coverage requires two securely injected certification session tokens:
`LUXIA_CERT_<PROFILE>_HTTP_SESSION_TOKEN` and
`LUXIA_CERT_<PROFILE>_FOREIGN_HTTP_SESSION_TOKEN`. They must be provisioned for
scoped certification subjects with providers read/manage permissions, never a
Production session. The foreign subject must have its own tenant permissions,
so denial is the provider scope check (404), not merely missing permission.
The runner launches its own loopback-only Next server, injects only runtime DB
credentials (no migration URL), performs authorized connection testing and
foreign-scope read denial, and scans captured HTTP bodies/headers and application
stdout/stderr in memory. Capture overflow is a failure. Raw logs and secret
values are never printed or persisted. No arbitrary HTTP base URL is accepted.

An hourly thread heartbeat now checks prerequisites and maintains branch expiry
when less than 24 hours remain; it must not use Production credentials or call
providers while prerequisites are missing. PR stays Draft until all three
complete reports and CI pass on the same SHA. No repository production workflow
was changed; these local runners do not themselves change PR metadata.

Until credentials, consent and issuer approval are available, make **no external
provider calls**. Then run each profile independently: connection, discovery,
1000-item/10-page boundaries, invalid/revoked credentials, insufficient consent,
disabled management operations, mapping, replay and cross-tenant denials.
Use controlled dedicated directory fixtures, not business identities.
Record immutable IDs rather than merging by email or display name.

Capture before/after identity and legacy inventories; assert zero dry-run
canonical writes. Verify collisions/quarantine, canonical audit for success,
rejection and failure. Scan HTTP/log/audit captures against secret values in
memory without printing them. An automated-test PASS does not certify real
consent/connectivity. PR becomes Ready for Review only after all live evidence;
merge remains separately prohibited.

## Current gate

```text
Certification DB: READY
Secret storage: READY
Entra environment: MISSING CREDENTIALS / MISSING CONSENT
Google environment: MISSING CREDENTIALS / MISSING CONSENT
OIDC environment: MISSING APPROVED ISSUER
LIVE PROVIDER CERTIFICATION: BLOCKED
Production touched: NO
```

MISSING means unavailable/unverified here, not proof that no external resource
exists. Secret storage READY refers to the dedicated GitHub environment, not
the availability of Entra/Google credentials or consent.

## Official references

- https://neon.com/blog/instant-branches-schema-only-or-with-data-the-choice-is-yours
- https://neon.com/blog/expire-neon-branches-automatically
- https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0
- https://developers.google.com/workspace/admin/directory/v1/guides/authorizing
