# Resources & Governance v1 — architecture proposal

Status: initial architecture proposal; its resource foundation is implemented on the independent branch. The executable contract in `docs/operations/RESOURCES-GOVERNANCE-V1.md` supersedes the initial binding/scope proposal below: RESOURCE, RESOURCE_GROUP and TENANT are explicit flat scope kinds, with Entitlement.resourceScopeId as the canonical binding. SoD and Access Reviews remain proposals, not implementations. No Production mutation applied.
Audit baseline: main `07bbd51693949d06994b20e2aa1ee25e46e1d17b`.
Independent branch: `feat/resources-governance-v1`.
PR #12 remains frozen at `d604a48fa62fbec65676c0423a08645805d67129`.
Providers live certification: BLOCKED — waiting for external credentials.

## 1. Verified current state

- `Resource` has required `organizationId`, `tenantId`, name and type; optional providerConnectionId, externalId, description and metadata. Its Tenant FK is composite, its ProviderConnection FK is organization-scoped. Uniqueness: id and (organizationId, id), not externalId.
- Existing ResourceType: APPLICATION, API, DATASET, DATABASE, REPOSITORY, CLOUD_RESOURCE, SAAS, STORAGE, SECRET, AI_TOOL, OTHER. DEVICE, SERVICE, WORKLOAD and AI_AGENT resource kinds are absent. Subject types remain identity semantics, not resource ownership.
- `Entitlement` has key, action and resource **strings**, with unique (organizationId, tenantId, key) and (organizationId, tenantId, id). There is no FK to Resource. Existing `resources.read/manage` governs catalog administration, not access to an individual application.
- `Assignment` references Subject and Entitlement through tenant-composite FKs, has source/sourceRef, status and temporal bounds. SQL has an ACTIVE partial unique index over scope, subject, entitlement, source and coalesced sourceRef, and a time-range CHECK. Preserve these constraints.
- Resource, Entitlement and Assignment migrations ENABLE and FORCE RLS using transaction-local organization/tenant settings. This is source evidence, not a new live DB certification.
- `/api/canonical/resources` GET/POST and `[id]` PATCH exist; services use withTenantDb and transactional CanonicalAdminAuditEvent. Assignment read/grant/revoke APIs exist, but grant only accepts the static entitlement catalog.
- Native `authorize()` matches catalog resource/action strings and active temporal assignments, not Resource IDs. Its query does not explicitly check Subject lifecycle. The gateway still evaluates legacy in parallel even in native mode; new governance authority must not use legacy fallback.
- CanonicalAdminAuditEvent already supplies actor/target, scope, operation, assignmentIds, changeId and result. Reuse it; do not create a legacy AuditLog dependency. Existing metadata key filtering is not sufficient for arbitrary free-text secret protection: new operations need bounded allowlisted metadata.
- No AccessReview or Separation of Duties persistence found. Dashboard illustrates resource categories but has no dedicated resources/governance pages. No actual resource enforcement integration is certified by those illustrations.
- Existing security tests cover canonical APIs and source boundaries; new resource-specific decisions, concurrency and real PostgreSQL/RLS tests are required.

## 2. Minimal additive model (proposed names, not existing schema)

Preserve Subject → Assignment → Entitlement; add Entitlement → Resource → ResourceScope.

1. Extend ResourceType with SERVICE, DEVICE, WORKLOAD, AI_AGENT. Add Resource lifecycle ACTIVE/DISABLED/ARCHIVED and a version for concurrency. Preserve all existing types and records. An AI_AGENT Subject and an AI_AGENT Resource are different objects; neither creates the other automatically.
2. Add `ResourceScope`: organizationId, tenantId, resourceId, id, key, description. A scope is an explicit resource boundary, not a wildcard or inferred URL prefix. Unique (organizationId, tenantId, resourceId, key); tenant-composite Resource FK. v1 scopes are flat; no implicit inheritance.
3. Extend Entitlement additively with nullable resourceId and resourceScopeId. Existing rows retain null and their surface-administration meaning. CHECK requires both new fields together. Composite FKs require scope to belong to that same resource and tenant. New resource grants must always have both fields, an explicit bounded action, and server-generated unique keys; never treat a null binding as permission to all resources.
4. Add Resource composite unique (organizationId, tenantId, id), needed for the new FKs. Preserve Assignment's existing FK, uniqueness and history; no new parallel grant table.
5. Add `AccessReview` campaign and immutable `AccessReviewItem` decisions, with tenant-composite Subject/reviewer/Assignment FKs, expiry, optimistic version and a snapshot of the reviewed grant version. Decisions KEEP/REVOKE require an authorized reviewer distinct from the beneficiary. A stale grant requires re-review, not automatic application. REVOKE atomically revokes the original assignment and writes audit; KEEP never grants or extends access.
6. Add versioned `SeparationOfDutiesRule` and conflicting-entitlement pair entries with tenant-composite Entitlement FKs. v1 supports preventive static mutually exclusive effective grants only, across the tenant. No exception/override API, dynamic duty policy or global rule in v1. Rule creation validates existing grants and rejects activation if existing conflicts remain.

Every new table: organizationId and tenantId required, composite FK integrity, ENABLE + FORCE RLS, tenant-leading indexes, app_user least-privilege grants. Migration must not seed business data or grants. Assess any existing key collisions before additive constraints; never silently merge or rewrite records.

## 3. Enforcement and audit

- A new resource authorization service requires authenticated canonical Subject, exact Resource and ResourceScope IDs and action. Inside withTenantDb, check ACTIVE Subject/resource, exact scope, ACTIVE Assignment and validFrom/validUntil, bound Entitlement and applicable SoD rules. Unknown resource/action/scope, missing context, revoked grant or unsupported integration => DENY.
- Return an evidence decision including Subject, Assignment, Entitlement, Resource and scope IDs, evaluatedAt and safe reason. Never derive authorization from provider claims, email, name, legacy Role or Permission.
- Shared tenant/subject grant serialization prevents two concurrent conflicting grants. All existing assignment mutation paths must invoke the same SoD guard for resource-bound grants; there must be no alternate grant bypass. Recheck decisions at mutation time, not only in HTTP middleware.
- Management rights and protected-resource access remain distinct: resources.manage does not grant application use; assignments.manage is not an unrestricted self-elevation mechanism. Introduce explicit per-entitlement delegable grant authority and deny self-grant; require an independently authorized actor. No new admin assignments are seeded automatically.
- Mutations and SUCCESS audit commit atomically. Controlled scoped DENIED decisions return a sentinel so evidence commits before throwing outside the transaction. Failure to persist mandatory audit prevents a successful mutation. Foreign IDs yield non-enumerating 404/DENY in the actor's scope.
- Idempotency uses tenant-scoped changeId plus operation/payload fingerprint (non-secret fields): identical replay returns original outcome, different payload conflicts; no duplicate grants or decisions.
- Audit allowlist includes resourceId, resourceScopeId, entitlementId, assignmentIds, reviewId, ruleId, version and reasonCode as needed. No credentials, tokens, provider responses or arbitrary metadata copied into audit.

## 4. Real surfaces and permissions

Reuse resources.read/manage, assignments.read/manage and audit.read only where their existing routes consume them. Add permissions only together with a consuming route/service:

- `/dashboard/resources` and detail: real persisted resources/scopes; create/edit/disable, entitlement definitions and assignment trace.
- Canonical resource-scope and entitlement APIs: resources.read/manage for configuration, with exact tenant/resource validation. New governed grants use the additional explicit grant authority described above.
- `/dashboard/governance`: actual review campaigns/items and SoD rules; `access_reviews.read/manage/decide`, `sod.read/manage` with matching protected APIs. Reviewer eligibility is also enforced per review item.
- Catalog filters cover applications, APIs/services, devices, workloads and AI agents using real records. Empty lists remain empty. No generated metrics, example identities or synthetic audit history.
- Protected Luxia route/service integration invokes the resource decision service; add a documented server-side enforcement contract for external services. A registered external application is only catalogued until its actual enforcement point is connected and tested. Do not call it protected merely because it has a record.
- Hide unsupported actions, show permission denials clearly, paginate all lists. No integration button without a working backend. No dependency on PR #12 provider-management routes/types/migrations.

## 5. Implementation and exit gates

1. Additive resource binding/scopes and canonical enforcement, unit/architecture tests.
2. Centralized governed grants + preventive SoD, concurrent grant/rule-change tests.
3. Reviews with immutable snapshots, independent reviewer, atomic revocation, stale/conflict/idempotency tests.
4. Resource/governance APIs and real UI plus actual protected route integration.
5. Isolated DB migration from main; app_user NOSUPERUSER/NOBYPASSRLS/no ownership; real FK/CHECK/index/RLS tests, cross-organization and cross-tenant denial. No Production DB access.
6. Positive and negative HTTP/E2E, zero legacy authority/mutations, audit persistence and redaction, authorization revocation effectiveness, build/TypeScript/security suites and CI on the final branch SHA.

Required evidence: scoped resource access trace, disabled/non-ACTIVE denial, time-bound assignment expiry, review revoke preserving history, concurrent SoD conflict denial, no grant bypass through old APIs, no self-elevation, no global/wildcard permission, no UI fixture data and no secret exposure. No PASS until exercised; source inspection alone is not DB certification.

## 6. Rollout and boundaries

No Production migration, grant, deployment or cutover in this proposal. Existing provider/login/session and legacy data stay unchanged. Keep resource-bound authorization separate from existing catalog semantics; do not silently reinterpret old entitlements. Rollback disables new routes and revokes only specifically created grants with audit; preserve review/audit history and additive schema.

No provider live calls, provider provisioning, directory discovery, Trust Graph, general Policy Engine, Trust Ledger, AI tool governance or edge runtime implementation. AI-agent resource access is included; autonomous-agent governance is not. External enforcement requires a real integration and credentials supplied by its operator, not a fabricated endpoint.

Next implementation slice: resource-scoped entitlement binding and canonical decision evidence with additive migration and isolated PostgreSQL/RLS tests. Governance mutations follow only after this architecture proposal is reviewed.
