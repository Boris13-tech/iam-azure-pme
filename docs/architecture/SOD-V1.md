# Static Separation of Duties v1

Scope: PR #13 only. No Production mutation, provider integration, legacy authority or Access Review.

Policies default to DISABLED and target an existing RESOURCE, flat RESOURCE_GROUP or TENANT ResourceScope. Ordered pairs of distinct, tenant-scoped, resource-bound Entitlements are mutually exclusive. Rules have a single enforcement: DENY. Composite foreign keys and ENABLED + FORCED RLS isolate policies and rules. No rule is interpreted by role name.

Conflict exists when the candidate and an existing non-legacy ACTIVE assignment have overlapping validity intervals and their resource scopes intersect the policy scope. Revoked, expired and non-overlapping grants do not conflict. Temporarily inactive resources do not erase security restrictions. Disabled policies never deny; SOD_POLICY_DISABLED is informational. SOD_SCOPE_MISMATCH describes a nonparticipating scope or rejects a supplied resource outside its claimed scope.

All governed mutations acquire the same organization/tenant advisory transaction lock. A broader tenant lock is intentional for the first static slice: policy changes and assignment changes cannot race. Assignment create, modify and reactivate evaluate before writing. A security-invoker database trigger is an additional activation backstop and obeys RLS. It does not fabricate durable audits for aborted raw SQL transactions; the supported service path returns a denial sentinel, commits ASSIGNMENT.DENIED.SOD, then throws outside the transaction.

DENY audit fields are limited to subjectId, entitlementId, resourceId, policyId, ruleId and scopeType. Request changeId deduplicates the evidence. No rejected assignment is inserted. Policy activation and rule creation validate existing grants under the same lock; a savepoint rolls back rejected policy/rule writes without rolling back their denial audit. Administrator subjects are not exempt. Initial conflicting entitlements must be held by separate delegators; existing bounded-delegation rules are preserved.

Consumed native administrative keys: sod.read (policy/conflict reading and evaluation), sod.manage (policy creation/status and rule creation/disable). No entitlement or assignment is automatically seeded. Mutations require x-luxia-change-id and persisted sessions. Tenant/org are never accepted from the request body.

API: /api/canonical/sod/policies (GET/POST), /policies/:id (GET/PATCH), /policies/:id/rules (POST), /rules/:id (DELETE means disable, not destructive deletion), /evaluate (POST), /conflicts (GET). Existing resource-governance assignments gain PATCH for bounded modification/reactivation. UI: /dashboard/governance/sod uses these real APIs only.

Tests: actual app_user PostgreSQL/RLS, no bypass/ownership, exact committed DENY evidence, assignment absence, replay, concurrency, disabled policy, activation rollback, revoke/expiry, wrong resource, lifecycle, foreign scope and HTTP APIs. Full resource/security/provider/identity suites and GitHub CI must pass before certification. Raw SQL privileges are not an alternative admin API; privilege changes require a separately reviewed production plan.

Non-goals: dynamic/contextual SoD, multi-step approval, Access Reviews, role-based exclusions, nested groups, automatic remediation, Production rollout. Policies are static and scope membership is immutable through this API.
