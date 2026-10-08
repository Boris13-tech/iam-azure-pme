# First protected capability — before implementation

Baseline: `023814e9d6a9e97122150999c0ef9d692413e03c`.
Branch: `feat/resource-access-onboarding-v1`. Production and PR12 are excluded.

## Actual integration

LUXIA owns `GET /api/resources/protected-resource-demo`. It returns only a small
server-generated acknowledgement after canonical authorization, not dashboard data.
This is a real protected HTTP capability, not a simulated business application.

- Resource name: LUXIA Internal Resource Test
- Type: API
- Resource ID: `ed8c9111-a930-4724-a76d-bd541538a621`
- RESOURCE scope ID: `3952f920-c064-46a2-9d22-d31d338c8a54`
- Entitlement ID: `d6605f22-64f1-467b-b4e4-de806d2c957c`
- Action: `resource.read`
- Entitlement key: `resource-scope:3952f920-c064-46a2-9d22-d31d338c8a54:resource.read`
- Organization: `4841428a-80b4-4f07-bb3f-c94612dfd4a2`
- Tenant: `c68ae9ee-11a8-42f9-bc9c-b19c42ec7914`

These IDs define this integration only, not universal identity semantics. The route
derives Subject from the persisted canonical session and ignores client-selected
Subject, Resource, action, entitlement and tenant claims. Exact binding is checked
before invoking native resource authorization. No catalogue/admin permission is
treated as authority to read the capability.

## First slice and hard stop

Configuration can create the exact Resource/RESOURCE scope/Entitlement atomically,
but creates **zero Assignments**. Server-issued tenant/actor-bound plan IDs are the
operation identifiers; an immutable canonical receipt records the bounded plan.
Confirm/replay has one effect and one canonical apply audit, not one per retry.
Replays revalidate current state and cannot reactivate revoked/inactive objects.
Controlled denials commit evidence before a service exception is thrown.

The existing canonical Subject can be selected; no employee or owner is invented.
Preview reports SoD, self-grant and effective authority without creating an access.
Delegation is BLOCKED until a separate exact first-owner bootstrap is approved and
tested. No owner grant implementation or execution is smuggled into configuration.

## Operator bootstrap proposal — NOT APPROVED / NOT EXECUTABLE

Proposed real target Subject: `30a15eda-24d3-40ef-8705-11c2e6e1b929`.
Only the exact Resource/scope/Entitlement above may be bootstrapped. Proposed maximum
validity: one hour from explicit execution approval; the approval manifest must pin
absolute validFrom/validUntil before execution. A relative duration alone is not an
executable approval. There is no wildcard, resource group or tenant-wide grant.

Future implementation must require out-of-band operator approval of the complete
immutable manifest (environment, actor, target, IDs, action, absolute timestamps,
operation ID, manifest version). Persist approval provenance and its binding digest,
not a secret or a token. Approval must not be accepted from the browser. Under the
existing tenant lock, revalidate active Subject/bindings, SoD and expiry, create one
DIRECT Assignment plus audit atomically and return an idempotent receipt. Reuse with
changed fields or after revoke/expiry must DENY with independently committed evidence.
No runtime admin permission may substitute for that approval.

Rollback revokes only the recorded bootstrap Assignment and audits the revocation;
it preserves identity, existing grants and all historical evidence. Do not relax the
normal service's self-grant/self-modify/effective-authority protections. Since the
current tenant has only one real Subject, testing normal delegation needs a second
real, explicitly supplied canonical Subject; none is fabricated for a demonstration.

### Required immutable approval manifest

The following is a design, not a signed approval or a usable grant request:

| Field | Pinned value / required validation |
|---|---|
| manifestVersion | 1 |
| purpose | INITIAL_BOUNDED_RESOURCE_OWNER |
| environment | CERTIFICATION_ONLY; exact branch `br-flat-dream-ahgvk9x6`, database `neondb` |
| organizationId / tenantId | The exact two IDs in the capability definition |
| actorSubjectId / targetSubjectId | `30a15eda-24d3-40ef-8705-11c2e6e1b929`, existing canonical Subject |
| resourceId / scopeId / entitlementId | Exact capability IDs above; kind RESOURCE only |
| action / entitlementKey | Exact `resource.read` and scoped key above |
| assignmentId | Reserve one UUID in the final manifest, before approval |
| validFrom / validUntil | Absolute UTC timestamps, pinned before execution; positive interval <= one hour |
| operationId | Server/operator-issued UUID, unique within Organization/Tenant |
| approvalReference / approvedAt / approvedBy | Explicit human approval of this complete manifest; never a browser boolean |
| manifestBinding | Digest/signature over all fixed fields; not a credential/token hash |

Execution must reject Production endpoints independently of an environment label.
The operator approval is required **also for the clone**: no fixture owner grant may
be inserted to manufacture an ALLOW result. Approval is non-transferable to another
Subject, action, tenant, scope, Resource, grant ID, longer expiry or environment.

Audit operations proposed: `RESOURCE.ONBOARDING.BOOTSTRAP` SUCCESS,
`RESOURCE.ONBOARDING.BOOTSTRAP.DENIED` DENIED and
`RESOURCE.ONBOARDING.BOOTSTRAP.REVOKE` SUCCESS. All use the new append-only evidence
guard, tenant FK/RLS, fixed metadata allowlist and a denial-sentinel transaction.
An exact successful replay returns the original receipt only while its Assignment
is still effective. Revoked/expired receipt replay cannot recreate an Assignment.
A changed manifest with the same operationId is a separately persisted, deduplicated
DENY, never an update of the original evidence. Unique operation receipt + the same
resource-governance/SoD lock prevent concurrent initial owners or duplicate effects.

No executable approval manifest has been generated: its absolute timestamps,
reserved Assignment UUID and approval provenance require the separate approval gate.

## Certification distinction

Pre-bootstrap tests may prove real HTTP DENY, committed refusal evidence, binding,
configuration idempotency and isolated app_user/RLS. They cannot prove an approved
bootstrap, HTTP ALLOW or revoke-to-DENY by inserting an unapproved fixture grant.
The full requested exit gate remains BLOCKED until the separate approval and its
tests exist. Providers, dashboard, Entra, passkeys, JML and governance are unchanged.
