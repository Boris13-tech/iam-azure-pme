# Canonical Administration v1

Status: implemented in code and migrations; not applied to Production.

## Architectural decisions

- `CanonicalAdminAuditEvent` is the tenant-scoped administrative evidence source. It is independent of legacy `User` and `AuditLog`.
- `ProviderConnectionTenantScope` gives an organization-owned connection explicit tenant visibility without changing the existing OIDC login lookup. Tenant administrators may change only the scope-local `displayName`; shared provider identity and external scope remain organization-owned and cannot be changed through this API.
- `IdentityAccount.status` and `disabledAt` provide an explicit, additive disable primitive. Disabling an account atomically revokes its active sessions.
- Native authorization continues to use `Entitlement` and `Assignment`. No legacy role or permission row participates.
- `LUXIA_ORG_ADMIN:v1` is a versioned bundle, not a row in legacy `Role`.
- Every canonical API checks one explicit entitlement and delegates data access to a service using `withTenantDb`.
- Every canonical administrative read or mutation records an audit event in the same tenant transaction. Mutation callers must provide `X-LUXIA-Change-Id`.
- Authenticated authorization denials record `AUTHORIZATION.DENIED` with `result = DENIED`; inability to write that evidence never turns a denial into an allow.
- Metadata keys that look like secrets, tokens, passwords, credentials, or private keys are rejected before persistence.

## API and entitlement matrix

| Surface | API | Entitlement | Audit operations |
|---|---|---|---|
| Audit | `GET /api/canonical/audit` | `audit.read` | `AUDIT.READ` |
| Subjects | `GET/POST /api/canonical/subjects` | `subjects.read`, `subjects.create` | `SUBJECT.READ`, `SUBJECT.CREATE` |
| Subjects | `PATCH /api/canonical/subjects/:id` | `subjects.update` | `SUBJECT.UPDATE` |
| Identity accounts | `GET/POST /api/canonical/identity-accounts` | `identity_accounts.read`, `identity_accounts.link` | `IDENTITY_ACCOUNT.READ`, `IDENTITY_ACCOUNT.LINK` |
| Identity accounts | `POST /api/canonical/identity-accounts/:id/disable` | `identity_accounts.disable` | `IDENTITY_ACCOUNT.DISABLE` |
| Assignments | `GET/POST /api/canonical/assignments` | `assignments.read`, `assignments.manage` | `ASSIGNMENT.READ`, `ASSIGNMENT.GRANT` |
| Assignments | `POST /api/canonical/assignments/:id/revoke` | `assignments.manage` | `ASSIGNMENT.REVOKE` |
| Sessions | `GET /api/canonical/sessions` | `sessions.read` | `SESSION.READ` |
| Sessions | `POST /api/canonical/sessions/:id/revoke` | `sessions.revoke` | `SESSION.REVOKE` |
| Providers | `GET/POST /api/canonical/providers` | `providers.read`, `providers.manage` | `PROVIDER.READ`, `PROVIDER.CREATE` |
| Providers | `PATCH /api/canonical/providers/:id` | `providers.manage` | `PROVIDER.UPDATE` |
| Resources/applications | `GET/POST /api/canonical/resources` | `resources.read`, `resources.manage` | `RESOURCE.READ`, `RESOURCE.CREATE` |
| Resources/applications | `PATCH /api/canonical/resources/:id` | `resources.manage` | `RESOURCE.UPDATE` |

Applications use the existing `Resource` model with `type = APPLICATION`.

## Bundle

The authoritative planned rows, UUIDs, scope, and assignment UUIDs are in
`docs/operations/canonical-administration-v1-bundle.json`.

The exact bundle contains:

1. `subjects.read`
2. `subjects.create`
3. `subjects.update`
4. `identity_accounts.read`
5. `identity_accounts.link`
6. `identity_accounts.disable`
7. `assignments.read`
8. `assignments.manage`
9. `sessions.read`
10. `sessions.revoke`
11. `providers.read`
12. `providers.manage`
13. `resources.read`
14. `resources.manage`
15. `audit.read`

The legacy keys `users.*`, `roles.*`, and `settings.*` are deliberately not part
of the native bundle.

## Future Production mutations

No statement in this section has been executed.

An approved application must perform one transaction that:

1. verifies the Organization, Tenant, active HUMAN Subject, and all UUID/key collisions;
2. creates or strictly reuses the 15 tenant-scoped `Entitlement` rows from the manifest;
3. creates the 15 `DIRECT` active `Assignment` rows with
   `sourceRef = native-role:LUXIA_ORG_ADMIN:v1`;
4. creates the tenant scope row for the existing Entra connection
   `fde0704e-0d1c-4c47-b53e-f19a60f1748d`;
5. records one `CanonicalAdminAuditEvent` with:
   - planned event ID `f269e276-f9bc-4f97-b780-e54eaee1a1a6`;
   - `operation = ROLE_BUNDLE.GRANT`;
   - `roleKey = LUXIA_ORG_ADMIN`;
   - `roleVersion = 1`;
   - all 15 assignment IDs;
   - a new approved, unique `changeId`;
   - `result = SUCCESS`.

No `Role`, `Permission`, `UserRole`, `AccessPolicy`, `AuditLog`, or
`LegacyUserBridge` row may change.

## Read-only dry-run

Run `scripts/canonical-admin-v1-dry-run.sql` with a read-only connection. Every
collision column must be `false`. The expected post-apply delta is:

- Entitlement: `+15` at the specified Organization/Tenant;
- Assignment: `+15` for the specified Subject;
- ProviderConnectionTenantScope: `+1` for the existing Entra connection;
- CanonicalAdminAuditEvent: `+1` for `ROLE_BUNDLE.GRANT`;
- every legacy table: `0` changes.

## Rollback

Rollback is evidence-preserving and must be a single tenant-scoped transaction:

1. mark all active assignments with the bundle `sourceRef` as `REVOKED`;
2. set `validUntil` to the rollback transaction timestamp;
3. do not delete Entitlement rows;
4. record `ROLE_BUNDLE.REVOKE` with the same role key/version and all revoked assignment IDs;
5. retain the provider-to-tenant scope unless the provider itself is separately decommissioned;
6. leave legacy tables unchanged.

## E2E gate after a separately approved apply

- all 15 entitlement decisions allow only for the intended Subject and scope;
- an unassigned entitlement remains denied;
- another Tenant and another Organization cannot see or mutate any canonical object;
- disabling an identity account revokes its sessions and prevents subsequent authentication use;
- a revoked session no longer resolves;
- a provider outside `ProviderConnectionTenantScope` is invisible and cannot be linked;
- resources and applications cannot reference an out-of-scope provider;
- duplicate `X-LUXIA-Change-Id` is rejected with no second mutation;
- secret-like metadata is rejected and never logged;
- `ROLE_BUNDLE.GRANT`, each tested administrative mutation, and rollback evidence are readable through the canonical audit API;
- RLS remains forced for Subject, IdentityAccount, Assignment, Entitlement, Session, Resource, CanonicalAdminAuditEvent, and ProviderConnectionTenantScope;
- legacy rows and both demonstration users remain byte-for-byte unchanged.
