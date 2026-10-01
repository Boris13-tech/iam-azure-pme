# Production Identity Bootstrap — Dry Run

Status: **PREPARATION ONLY — NO PRODUCTION WRITE AUTHORIZED**

Source commit inspected: `21ee6323719c828817fa6785194f72dd8a29da7c`

## Corrected Entra configuration

- Directory tenant ID: `b8f6e875-25cd-4d75-90ec-e6dd206057e5`
- Authoritative client ID: `811ded0e-7a03-4c10-9bfc-9f24efdb972b`
- Client secret: `[MASKED: VERCEL_PRODUCTION/ENTRA_AUTH_CLIENT_SECRET]`
- User OID: `e6ac473c-0e9a-4d04-bd02-4954b3caa6d2`

The client ID is runtime configuration and is not a column of any of the five canonical tables. Production currently requires a separate, explicitly authorized correction of `ENTRA_AUTH_CLIENT_ID`; this dry run does not change it.

## Schema verification

### Organization

Required explicit fields: `id`, `name`.

Database defaults: `createdAt = now()`, `updatedAt` managed by Prisma.

Actual uniqueness: primary key `id`. There is no unique constraint on `name`.

### Tenant

Required explicit fields: `id`, `organizationId`, `name`.

Actual relations and constraints:

- primary key `id`;
- unique `(organizationId, id)`;
- foreign key `organizationId -> Organization.id` with `ON DELETE RESTRICT`.

There is no unique constraint on tenant name.

### ProviderConnection

Required explicit fields: `id`, `organizationId`, `providerType`, `externalScopeId`, `name`.

Actual relations and constraints:

- belongs directly to `Organization`;
- has no `tenantId` column;
- unique `(organizationId, id)`;
- unique `(organizationId, providerType, externalScopeId)`;
- foreign key `(organizationId) -> Organization(id)` with `ON DELETE RESTRICT`.

### Subject

Required explicit fields: `id`, `organizationId`, `tenantId`, `type`, `name`.

Verified enums/defaults:

- `type = HUMAN` exists in `SubjectType`;
- `lifecycleState = ACTIVE` exists in `SubjectLifecycleState` and is the database default;
- `lifecycleVersion = 1` is the default and must remain greater than zero;
- `lifecycleChangedAt = now()`, `createdAt = now()`, and `updatedAt` are generated/defaulted.

Actual relations and constraints:

- unique `(organizationId, id)`;
- unique `(organizationId, tenantId, id)`;
- foreign key `organizationId -> Organization.id`;
- foreign key `(organizationId, tenantId) -> Tenant(organizationId, id)`.

### IdentityAccount

Required explicit fields: `id`, `organizationId`, `tenantId`, `subjectId`, `providerConnectionId`, `externalObjectId`.

`externalObjectId` is explicitly documented in the Prisma schema as the external provider object identifier, including an Entra user OID.

Actual relations and constraints:

- unique `(organizationId, id)`;
- unique `(organizationId, tenantId, id)`;
- unique `(organizationId, tenantId, subjectId, id)`;
- unique `(organizationId, providerConnectionId, externalObjectId)`;
- foreign key `(organizationId, tenantId, subjectId) -> Subject(organizationId, tenantId, id)`;
- foreign key `(organizationId, providerConnectionId) -> ProviderConnection(organizationId, id)`.

## Exact proposed inserts

These statements are documentation only and were not executed.

```sql
INSERT INTO "Organization" ("id", "name", "createdAt", "updatedAt")
VALUES (
  '4841428a-80b4-4f07-bb3f-c94612dfd4a2',
  'Legrand Tech',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "Tenant" ("id", "organizationId", "name", "createdAt", "updatedAt")
VALUES (
  'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914',
  '4841428a-80b4-4f07-bb3f-c94612dfd4a2',
  'Production',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "ProviderConnection" (
  "id", "organizationId", "providerType", "externalScopeId", "name", "createdAt", "updatedAt"
)
VALUES (
  'fde0704e-0d1c-4c47-b53e-f19a60f1748d',
  '4841428a-80b4-4f07-bb3f-c94612dfd4a2',
  'MICROSOFT_ENTRA',
  'b8f6e875-25cd-4d75-90ec-e6dd206057e5',
  'Microsoft Entra — Legrand Tech',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "Subject" (
  "id", "organizationId", "tenantId", "type", "name",
  "lifecycleState", "lifecycleVersion", "lifecycleChangedAt", "createdAt", "updatedAt"
)
VALUES (
  '30a15eda-24d3-40ef-8705-11c2e6e1b929',
  '4841428a-80b4-4f07-bb3f-c94612dfd4a2',
  'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914',
  'HUMAN',
  'Legrand Boris Ohandja Edimo',
  'ACTIVE',
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "IdentityAccount" (
  "id", "organizationId", "tenantId", "subjectId", "providerConnectionId",
  "externalObjectId", "createdAt", "updatedAt"
)
VALUES (
  '211fd18b-62cd-4fdf-85b1-731ae3c1cf24',
  '4841428a-80b4-4f07-bb3f-c94612dfd4a2',
  'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914',
  '30a15eda-24d3-40ef-8705-11c2e6e1b929',
  'fde0704e-0d1c-4c47-b53e-f19a60f1748d',
  'e6ac473c-0e9a-4d04-bd02-4954b3caa6d2',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
```

No `LegacyUserBridge`, `Assignment`, `Entitlement`, role transfer, session, or legacy-user update is proposed.

## Required live preflight before any future apply

The following checks must return zero rows. They are included in the dry run but have not been run against Production in this preparation step.

```sql
SELECT "id", "name"
FROM "Organization"
WHERE "id" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2';

SELECT "id", "organizationId", "name"
FROM "Tenant"
WHERE "id" = 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'
   OR ("organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2' AND "name" = 'Production');

SELECT "id", "organizationId", "providerType", "externalScopeId"
FROM "ProviderConnection"
WHERE "id" = 'fde0704e-0d1c-4c47-b53e-f19a60f1748d'
   OR (
     "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
     AND "providerType" = 'MICROSOFT_ENTRA'
     AND "externalScopeId" = 'b8f6e875-25cd-4d75-90ec-e6dd206057e5'
   );

SELECT "id", "organizationId", "tenantId", "name"
FROM "Subject"
WHERE "id" = '30a15eda-24d3-40ef-8705-11c2e6e1b929';

SELECT "id", "organizationId", "tenantId", "subjectId", "providerConnectionId", "externalObjectId"
FROM "IdentityAccount"
WHERE "id" = '211fd18b-62cd-4fdf-85b1-731ae3c1cf24'
   OR (
     "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
     AND "providerConnectionId" = 'fde0704e-0d1c-4c47-b53e-f19a60f1748d'
     AND "externalObjectId" = 'e6ac473c-0e9a-4d04-bd02-4954b3caa6d2'
   );

SELECT "legacyUserId", "subjectId", "status"
FROM "LegacyUserBridge";
```

Any row returned by the first five checks requires classification as an idempotent exact match or a collision. Any bridge involving either demonstration user is a blocker.

## Collision status

- Schema-level collision analysis: **PASS**.
- UUID collisions: **not observed locally; live read-only preflight still required**.
- Entra OID collision: **live read-only preflight still required**.
- ProviderConnection natural-key collision: **live read-only preflight still required**.
- Legacy demo mapping: **explicitly excluded**.

## Expected cardinalities after a future successful apply

Relative deltas:

| Table | Expected delta |
|---|---:|
| Organization | +1 |
| Tenant | +1 |
| ProviderConnection | +1 |
| Subject | +1 |
| IdentityAccount | +1 |
| LegacyUserBridge | 0 |
| Assignment | 0 |
| User | 0 |
| UserRole | 0 |

Using the last verified Production baseline, the expected absolute canonical counts would be `1 / 1 / 1 / 1 / 1`, while both legacy users and their role associations remain unchanged. Those absolute counts must be reconfirmed by the live preflight immediately before any write.

## Dry-run result

**PREPARED, NOT EXECUTED.**

No Production transaction, database mutation, deployment, legacy mapping, or role transfer was performed.
