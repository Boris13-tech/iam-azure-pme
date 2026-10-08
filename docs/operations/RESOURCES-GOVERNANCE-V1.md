# Resources & Governance v1 — executable foundation

Branch: feat/resources-governance-v1, based on main, independent of Providers PR #12.
No Production deployment or data mutation authorized by this tranche.
No SoD or Access Reviews implemented.

## Native chain

Subject → Assignment → Entitlement.resourceScopeId → ResourceScope → Resource.

- RESOURCE: exact resourceId, tenant-composite FK.
- RESOURCE_GROUP: explicit ResourceScopeMember rows; no inferred membership or hierarchy.
- TENANT: explicit grant over resources in that same organization/tenant only. It is not global authority.
- Existing unbound catalog entitlements retain their surface-management meaning. They never authorize a protected resource. Native catalog evaluation excludes newly bound entitlements.
- Existing Resource types remain valid; SERVICE, DEVICE, WORKLOAD and AI_AGENT are additive. Subject type and Resource type do not imply a relationship or permission.
- Native authorization requires ACTIVE Subject, ACTIVE/effective/non-legacy-source Assignment, active Entitlement, active matching Resource, active matching Scope and exact tenant context. Unknown/unbound/missing/expired/revoked => DENY. Provider claims and role names are never consulted.
- The server API checks only the authenticated Subject. It cannot accept a client-supplied Organization/Tenant/Subject to impersonate another identity.

## APIs

All routes below use `/api/canonical/resource-governance`, persisted sessions, withTenantDb and the runtime role.

| Path | Method | Native management authority |
| --- | --- | --- |
| /resources | GET / POST | resources.read / resources.manage |
| /resources/:id | GET / PATCH | resources.read / resources.manage |
| /scopes | GET / POST | resources.read / resources.manage |
| /entitlements | GET / POST | resources.read / resources.manage |
| /entitlements/:id/revoke | POST | resources.manage |
| /assignments | GET / POST | assignments.read / assignments.manage |
| /assignments/:id/revoke | POST | assignments.manage |
| /authorize | POST | authenticated ACTIVE Subject; evaluates its own actual grant |
| /audit | GET | audit.read |

POST/PATCH require x-luxia-change-id (1–128 safe characters). Replays return 409 without another mutation/audit. JSON schemas are strict; no arbitrary metadata/secret fields accepted. List endpoints cap at 100 records; `after` takes the last returned UUID for the next page.

Resource create accepts name/type; PATCH accepts name/active. Scope create accepts key/kind and either resourceId for RESOURCE or bounded resourceIds for RESOURCE_GROUP; TENANT accepts no target IDs. Scope bindings/membership are immutable in this slice: create a new explicit scope rather than silently widen an existing grant.

Entitlement create accepts scopeId/action/label; its unique key is server-generated `resource-scope:<scopeId>:<action>`. It never rebinds old administration entitlements. Revoke disables the entitlement and revokes its active assignments atomically, retaining history.

Assignment create accepts subjectId/entitlementId/validUntil. A native assignments.manage grant alone cannot confer arbitrary resource access: the actor must hold that exact effective resource entitlement for at least the requested lifetime. Self-grant is denied. Initial resource authority requires separately approved bootstrap; no migration or UI auto-grant exists. Assignment revocation retains history and rejects self-revocation.

Management controls serialize within the tenant and re-evaluate native authority inside the mutation transaction. Successful writes and canonical audit commit together. Controlled denials return a sentinel, commit DENIED evidence, then throw outside the transaction. Unexpected DB/audit errors roll back the transaction. Authorization decisions persist result SUCCESS or DENIED and their full ID trace; no provider secrets enter audit.

## UI and enforcement boundary

`/dashboard/resources` is a real paginated catalogue with Applications/APIs/Services/Devices/Workloads/AI Agents filters, native-authorized creation and resource detail reads. Empty tenants show no generated records. Server authorization is authoritative even if a client misrepresents its UI state.

A resource record does not install an enforcement agent or secure an arbitrary external service. Integrations must call `lib/resources/authorization.authorize()` with trusted server/session context and enforce `allowed === true` before the protected operation. Infrastructure errors return DENY. External enforcement integration/cutover is not claimed by catalogue registration.

## Certification

Dedicated schema-only Neon branch: br-withered-hall-ahvj9ru3, project hidden-leaf-91460552.
Test database: luxia_resources_cert; expires 2026-10-06T12:00:00Z. No Production rows copied. The parent-schema copy is retained untouched; a fresh database receives all main migrations plus the additive resource migration.

Run local unit/architecture tests: `npm run test:resources` (real DB suite explicitly skipped without LUXIA_RESOURCE_RLS=true; this alone is NOT an RLS PASS).
Real suite requires DATABASE_URL app_user and DATABASE_MIGRATION_URL fixture/migration role, with LUXIA_RESOURCE_RLS=true. CI uses isolated localhost PostgreSQL. `scripts/certify-resources-local.cjs` guards the dedicated Neon endpoint/database, injects runtime credentials in memory and suppresses raw process errors. It never stores credentials in files or GitHub or touches the Providers secret store.

PostgreSQL tests certify runtime posture, FORCE RLS, scoped composite FKs, all six kinds, all three scope modes, ten required allow/deny cases, real mutation/audit pairing, denial commit, audit-FK rollback, self-grant denial, bounded grant authority, idempotent request refusal, canonical API HTTP flows with persisted sessions, invalid/revoked-session refusal and unchanged legacy checksum. Certification-only fixture subjects/resources are not product data or UI fallback data. Fixture histories stay in this expiring isolated database for evidence; cleanup is branch expiration, not deletion of Production records.

Final gate results and exact SHA belong in the PR evidence, not inferred from schema inspection. Require full existing security/provider/identity/operations/parity/build/cutover CI plus the new resource/RLS suite before any PASS claim or push approval.

## Rollback / rollout

No Production action in this phase. Disable new routes/navigation if rolling back code; do not drop audit history or change legacy models. Revoke explicitly created grants with canonical audit; keep additive schema. A future production plan must separately approve migration, exact native bootstrap grants and enforcement integrations. PR remains Draft; no merge.
