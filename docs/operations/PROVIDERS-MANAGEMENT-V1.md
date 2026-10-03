# Providers Management v1 — first slice

Status: implementation under review. Production deployment and live-provider certification pending.

## Model and boundaries

`ProviderConnection` remains organization-owned with existing uniqueness `(organizationId, providerType, externalScopeId)`. `ProviderConnectionTenantScope` owns operational enablement, configuration, mapping versions and status. `ProviderSyncRun` has a composite FK to that exact scope, forced RLS, tenant-scoped operation uniqueness and database constraints prohibiting write-back counters. `ProviderIdentityCollision` remains the quarantine model. Canonical identities are `Subject`, reached through `IdentityAccount`; provider-management operations never create, update or delete either model.

The additive migration is `20261003000000_providers_management_v1`. Existing connections default to disabled management operations. Existing Entra login and LUXIA_LOCAL authentication remain on their validated paths: operational disablement in this slice controls management traffic, not existing authentication sessions. Authentication-provider disablement requires a separate tested routing change before this can be used as an authentication kill switch.

## Exposed capabilities

| Provider | Connection test | Discovery/dry-run | Provisioning |
|---|---|---|---|
| Microsoft Entra | OAuth client credentials plus Graph read | Graph users, bounded to 1000 / 10 pages | Unavailable |
| Google Workspace | Scoped Directory users read | Directory users, bounded to 1000 / 10 pages | Unavailable |
| Generic OIDC | Discovery metadata and exact issuer verification | Explicitly unsupported by OIDC protocol | Unavailable |
| LDAP/AD/Samba/GitHub/AWS | Existing adapter contracts; management integration pending | Management UI offers no unsupported actions | Unavailable |
| SAML/SCIM | Additive provider discriminators and management operation boundary; protocol adapter pending | Unavailable | Unavailable |

OIDC's test validates published metadata, not a full login or client-secret exchange. Entra and Google live tests require customer credentials and consent; automated HTTP fixtures do not prove customer connectivity.

## Credentials and configuration

The secret environment reference is derived from SHA-256 of the JSON array `[organizationId, tenantId, providerConnectionId]`, prefixed `LUXIA_PROVIDER_`. The API rejects a different scope's reference. Only the reference is stored; raw tokens/secrets are provided to the runtime secret resolver. References themselves are nonsecret and displayed for the operator to configure the secret store. No original secret value is returned or audited.

Entra requires a real Directory ID, Graph client ID and secret with least-privilege read permission/admin consent. No reuse of existing OIDC or global Graph credentials is assumed. Google requires an exact customer ID (not `my_customer`) and a separately supplied, scoped access token; automatic refresh/service-account delegation is not part of this slice. Expired credentials produce a safe failure.

OIDC issuers must be exact entries in operator-controlled `LUXIA_OIDC_ALLOWED_ISSUERS`, HTTPS, without userinfo/query/fragment. Operators must approve only public issuers accessible under their egress policy. No redirects are followed. Custom internal issuers need an explicitly reviewed edge/egress deployment; arbitrary admin-provided URLs are rejected.

## Operations and permissions

`providers.read` protects lists, details, sync history and collision reads. `providers.manage` protects configuration, enable/disable, connection test, dry-run and collision rejection. Every operation uses `withTenantDb`, explicit scope keys, and canonical audit. `x-luxia-change-id` is mandatory for mutations.

Mapping updates require the expected configuration version; operation/configuration setup is serialized with a transaction advisory lock. A running operation prevents concurrent configuration changes. Same-operation retries reuse persisted runs; another operation using the same ID fails. Runs are created before network access and finalized with safe codes and counters afterward. A process interruption can leave a RUNNING row requiring operator reconciliation; no automatic stale-run cancellation is implemented yet.

Dry-run uses stable external identifiers only, preserves existing Google projection normalization and never matches canonical Subjects by display name/email. Duplicate IDs quarantine explicit collision records. Reviewers can reject the projection, with a canonical audit event. Rejection does not create a link, grant permission or suppress later collisions. Controlled account linking remains the separately authorized IdentityAccount surface; approval/linking from a discovery result is deferred until mapping certification.

## Validation and release

Automated gates cover immutable ID mapping, duplicate quarantine, safe errors, bounded/replayed pagination, issuer checks, secret scoping, optimistic version conflicts, idempotency and runtime RLS. PostgreSQL integration executes only in an isolated test database under `app_user`; fixtures are created/removed by the test helper owner. No Production fixtures are created.

Before deployment, require green migration/security/provider/identity/Entra/build/cutover CI and isolated migration review from the current Production schema. Live provider tests and consent verification must be recorded separately; they cannot be labeled PASS from fixture tests. Production is not modified by this PR.

## Sources

- [Microsoft Graph users API](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0)
- [Google Directory users.list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/list)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)
