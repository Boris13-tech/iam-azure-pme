# Provider pre-network denial audit

No migration. No authentication kill-switch. `enabled` still controls management
operations only. No Production change or real provider call during validation.

After resolving the Organization/Tenant connection scope, the operation transaction
serializes on its existing advisory lock. Every controlled refusal persists
`PROVIDER.<requestedOperation>.DENIED`, result `DENIED`, current scoped actor,
and only `providerConnectionId`, `reasonCode`, `requestedOperation` as metadata.
It returns a denial sentinel; `CanonicalAdminError` is raised only after commit.
Evidence persistence failure fails closed and never invokes the driver.

Covered reasons: PROVIDER_DISABLED, PROVIDER_OPERATION_UNSUPPORTED,
DIRECTORY_DISCOVERY_UNSUPPORTED, PROVIDER_OPERATION_IN_PROGRESS,
PROVIDER_OPERATION_ID_CONFLICT. Unresolved/foreign scopes retain 404 and create
no revealing provider audit record. Existing RUNNING runs are left untouched;
denials never create an additional run.

## Idempotence / compatibility

The existing audit unique constraint is Organization/Tenant/changeId. New START
events use `start:<ProviderSyncRun.id>` (COMPLETE already uses its run ID), leaving
the request changeId available for DENIED. Valid run replay produces no extra
audit. Repeated or concurrent identical denials produce one evidence row, with
exact actor, operation, provider and reason verified after insert.

Historical START events occupying request changeId are never rewritten. If that
key already belongs to historical or different evidence, denial uses
`denied:<SHA256(JSON.stringify([providerConnectionId,actorSubjectId,operation,reasonCode,requestChangeId]))>`.
This documented compatibility exception is required by the existing unique
constraint; normal denials (including conflicts on new runs) retain request
changeId exactly. Different reasons/actors/operations retain distinct evidence
instead of silently counting an unrelated event as proof. No sensitive input
or raw credential reference is hashed or persisted.

## Certification

`tests/certification/provider-denial-audit-rls.test.ts` runs separately from
legacy-mutating test files. It checks each refusal over real PostgreSQL with
app_user, concurrent retry, response status/error facade, committed DENIED row,
metadata allowlist, no factory invocation, no new RUNNING run, cross-tenant
invisibility, full identity/legacy inventories, historical START preservation,
valid replay, and audit-write failure remaining fail-closed.

The live runner requires an actual DENIED row; absence is FAIL. It never inserts
synthetic denial evidence. Credentials/consents remain prerequisites to live
provider certification; database-only tests do not certify external consent.
