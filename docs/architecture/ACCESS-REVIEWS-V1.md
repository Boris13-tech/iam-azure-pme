# Access Reviews v1

Status: implementation on PR #13; no Production migration, grant or deployment authorized.

## Authority and scope

Reviews consume only canonical `Subject → Assignment → Entitlement → ResourceScope → Resource` data. Native `access_reviews.read`, `access_reviews.create`, `access_reviews.decide`, and `access_reviews.manage` are consumed by real routes; no entitlement rows or administrative grants are seeded. Legacy roles and provider claims confer no authority.

The campaign references an existing active ResourceScope (`RESOURCE`, `RESOURCE_GROUP`, `TENANT`). Its scope type/resource are server-derived. One explicit ACTIVE HUMAN reviewer must hold an effective native `access_reviews.decide` Assignment in the same Organization/Tenant. The actor creating a campaign needs `access_reviews.create`; completion needs `access_reviews.manage`. Only the assigned reviewer can decide, and their entitlement and lifecycle are checked again on every request, including replay.

Default self-review is denied both during generation and by a database CHECK. There is no v1 exception policy. Select a different reviewer if they hold any eligible access in the campaign scope. This avoids creating an unfinishable self-review item. No manager/role/name/email inference.

## Snapshot semantics

Campaigns snapshot actual, non-legacy, currently effective ACTIVE Assignments of ACTIVE Subjects, with active resource-bound Entitlements. Unbound administration entitlements are not represented as fictitious Resources and are outside this first slice. A scope must resolve to real active Resources. Bounds are 1,000 candidate Assignments and 1,000 Resources per scope; exceeding bounds rejects rather than silently truncating a campaign. Read routes paginate at 100 rows with UUID cursors. The create configuration route offers up to 100 real scopes/reviewers; larger catalogs can use explicit IDs through the API.

One immutable item represents one whole Assignment. It retains the original Subject, Entitlement, scope, assignment/entitlement update timestamps and full resource-ID projection. A campaign scope selects intersecting grants; it does **not** split a broad grant into narrower Assignments. The UI explicitly states that REVOKE removes the entire grant, including all its resources.

Campaign creation, items and `ACCESS_REVIEW.CAMPAIGN.CREATE` commit together. Campaign scope, reviewer, dates and item snapshot columns are immutable. Tenant-scoped compound FKs reference actual Subjects, Assignments, Entitlements, Resources and scopes; the item reviewer is constrained by its campaign FK. SQL CHECKs, immutable-row triggers, indexes and ENABLED/FORCED RLS complement application validation. Deletes are not exposed and are blocked by immutable guards.

## Decisions and concurrency

Campaign decisions require an OPEN campaign and `startsAt <= now < dueAt`. No background expiration decision or automatic grant is invented. A campaign can complete only after all items have decisions, including an empty campaign; overdue pending work requires future explicit remediation, not silent approval.

KEEP never writes an Assignment. It requires an unchanged, still-effective grant, active identity/entitlement and matching current scope projection. It re-evaluates existing static SoD excluding the assignment being reviewed. A conflict returns `REQUIRES_REMEDIATION`; stale/non-active access returns a safe error, retaining a pending decision with remediation state. DENIED canonical evidence and remediation commit before the error is thrown outside the transaction.

REVOKE updates the existing Assignment to REVOKED and commits the item decision and audit in the **same** transaction. Already revoked/expired access is recorded without creating or reactivating anything. Replaced/expanded active grants require remediation rather than revoking a new grant unknowingly. Reviewer input cannot change Subject, Entitlement, Resource or scope. Justifications are limited to 3–2,000 characters, are not copied to audit/log metadata, and reject recognizable bearer/private-key/token field patterns. Operators must not include secrets or unnecessary personal data in justifications.

All review writes acquire the existing Organization/Tenant `resource-governance` transaction advisory lock shared with Assignment/SoD operations and the database Assignment guard. Competing decisions serialize: exact decision+justification replay returns the original item with no write/audit; a different decision is denied. This also serializes conflicting grant changes. Unique scoped campaign+assignment snapshots prevent duplicate items. Change IDs are tenant-unique; reuse across intents is denied, and authorization is never bypassed by replay.

Unexpected database/audit failures roll back all writes. Tests deliberately fail a REVOKE audit insert on an isolated database and verify the Assignment and decision remain unchanged. Controlled errors use a committed sentinel, not audit-then-throw inside a rollback transaction.

## Audit and API

Success operations: `ACCESS_REVIEW.CAMPAIGN.CREATE`, `ACCESS_REVIEW.ITEM.KEEP`, `ACCESS_REVIEW.ITEM.REVOKE`, `ACCESS_REVIEW.CAMPAIGN.COMPLETE`. Controlled denials use the corresponding `.DENIED` operation and `result=DENIED`. Metadata is restricted to campaignId, itemId, subjectId, assignmentId, entitlementId, resourceId, reviewerSubjectId, decision. No provider credential, raw response, token, justification or secret is placed in evidence.

Session-derived auth; strict bodies reject organization/tenant/target overrides:

- POST/GET `/api/canonical/access-reviews`
- GET `/api/canonical/access-reviews/configuration`
- GET `/api/canonical/access-reviews/:id`
- GET `/api/canonical/access-reviews/:id/items` (`after`, `pending=true` for the current reviewer)
- POST `/api/canonical/access-reviews/:id/items/:itemId/decision`
- POST `/api/canonical/access-reviews/:id/complete`
- GET `/api/canonical/access-reviews/:id/audit`

UI: `/dashboard/governance/access-reviews`; all actions call these backends. UI visibility is advisory; server native entitlement checks and `withTenantDb`/RLS are authoritative.

## Certification and rollout

Real PostgreSQL tests use only `app_user` with NOSUPERUSER/NOBYPASSRLS/no table ownership. Owner access is limited to isolated fixtures, migration and a scoped test-only audit-failure trigger. Dedicated database `luxia_reviews_cert` is on the existing schema-only Neon certification branch `br-withered-hall-ahvj9ru3`, not its Production parent. No real customer records are copied.

Required proofs include active/revoked/expired generation, KEEP unchanged, REVOKE atomic/replay, immutable snapshots, stale access, assigned/native-authorized reviewer, self/cross-tenant DENY, SoD remediation, concurrent decisions, audit failure rollback, safe evidence and unchanged identity/legacy data. Real HTTP tests use persisted Sessions with runtime credentials, never an owner-backed server. Existing Resources, SoD, security, provider, identity and operational tests/build must remain green; CI must certify the pushed SHA.

Rollback is operationally disable access-review routes/navigation or revert unmerged application changes. Do not drop review evidence, recreate revoked Assignments, or reverse recorded decisions automatically. Production application/migration/grants require separate authorization after review. No merge, live provider certification, deployment or automatic role elevation is part of this slice.

Non-goals: recurring scheduler, manager inference, multi-reviewer escalation, dynamic SoD, partial grant revocation, new provisioning, legacy migration, provider implementation, Trust Graph/Policy/Ledger, Production cutover.
