-- LUXIA Production canonical identity bootstrap preflight.
-- READ ONLY: this file intentionally contains SELECT statements only.

BEGIN TRANSACTION READ ONLY;

-- Runtime posture. The preflight itself may run as the migration owner, but the
-- application runtime role must remain app_user without superuser/BYPASSRLS.
SELECT
  current_user AS preflight_executor,
  r.rolname AS runtime_role,
  r.rolsuper,
  r.rolbypassrls,
  has_function_privilege(r.rolname, 'public.resolve_session(text)', 'EXECUTE') AS resolve_session_execute
FROM pg_roles AS r
WHERE r.rolname = 'app_user';

-- Expected source baseline and canonical cardinalities.
SELECT 'Organization' AS entity, count(*)::bigint AS row_count FROM "Organization"
UNION ALL SELECT 'Tenant', count(*)::bigint FROM "Tenant"
UNION ALL SELECT 'ProviderConnection', count(*)::bigint FROM "ProviderConnection"
UNION ALL SELECT 'Subject', count(*)::bigint FROM "Subject"
UNION ALL SELECT 'IdentityAccount', count(*)::bigint FROM "IdentityAccount"
UNION ALL SELECT 'LegacyUserBridge', count(*)::bigint FROM "LegacyUserBridge"
UNION ALL SELECT 'Assignment', count(*)::bigint FROM "Assignment"
UNION ALL SELECT 'User', count(*)::bigint FROM "User"
UNION ALL SELECT 'UserRole', count(*)::bigint FROM "UserRole"
ORDER BY entity;

-- The only accepted legacy demonstration accounts. No bridge may exist for either.
SELECT
  u.id,
  u.email,
  u.name,
  u."azureId",
  COALESCE(
    array_agg(r.name ORDER BY r.name) FILTER (WHERE r.id IS NOT NULL),
    ARRAY[]::text[]
  ) AS roles,
  lub.id AS legacy_bridge_id
FROM "User" AS u
LEFT JOIN "UserRole" AS ur ON ur."userId" = u.id
LEFT JOIN "Role" AS r ON r.id = ur."roleId"
LEFT JOIN "LegacyUserBridge" AS lub ON lub."legacyUserId" = u.id
WHERE u.email IN ('admin@demo.com', 'jean.dupont@gmail.com')
GROUP BY u.id, u.email, u.name, u."azureId", lub.id
ORDER BY u.email;

-- Planned UUID collision checks. All five queries must return zero rows.
SELECT 'Organization.id' AS collision_type, "id" AS conflicting_id
FROM "Organization"
WHERE "id" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2';

SELECT 'Tenant.id_or_planned_name' AS collision_type, "id" AS conflicting_id
FROM "Tenant"
WHERE "id" = 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'
   OR (
     "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
     AND "name" = 'Production'
   );

SELECT 'ProviderConnection.id_or_natural_key' AS collision_type, "id" AS conflicting_id
FROM "ProviderConnection"
WHERE "id" = 'fde0704e-0d1c-4c47-b53e-f19a60f1748d'
   OR (
     "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
     AND "providerType" = 'MICROSOFT_ENTRA'
     AND "externalScopeId" = 'b8f6e875-25cd-4d75-90ec-e6dd206057e5'
   );

SELECT 'Subject.id' AS collision_type, "id" AS conflicting_id
FROM "Subject"
WHERE "id" = '30a15eda-24d3-40ef-8705-11c2e6e1b929';

SELECT 'IdentityAccount.id_or_entra_oid' AS collision_type, "id" AS conflicting_id
FROM "IdentityAccount"
WHERE "id" = '211fd18b-62cd-4fdf-85b1-731ae3c1cf24'
   OR (
     "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
     AND "providerConnectionId" = 'fde0704e-0d1c-4c47-b53e-f19a60f1748d'
     AND "externalObjectId" = 'e6ac473c-0e9a-4d04-bd02-4954b3caa6d2'
   );

-- Any existing use of the real Entra OID under another connection is a blocker.
SELECT
  ia.id,
  ia."organizationId",
  ia."tenantId",
  ia."subjectId",
  ia."providerConnectionId",
  ia."externalObjectId"
FROM "IdentityAccount" AS ia
WHERE ia."externalObjectId" = 'e6ac473c-0e9a-4d04-bd02-4954b3caa6d2';

-- No orphaned canonical references may exist before bootstrap.
SELECT 'Tenant.organization' AS orphan_type, t.id AS orphan_id
FROM "Tenant" AS t
LEFT JOIN "Organization" AS o ON o.id = t."organizationId"
WHERE o.id IS NULL
UNION ALL
SELECT 'ProviderConnection.organization', pc.id
FROM "ProviderConnection" AS pc
LEFT JOIN "Organization" AS o ON o.id = pc."organizationId"
WHERE o.id IS NULL
UNION ALL
SELECT 'Subject.scope', s.id
FROM "Subject" AS s
LEFT JOIN "Organization" AS o ON o.id = s."organizationId"
LEFT JOIN "Tenant" AS t
  ON t."organizationId" = s."organizationId" AND t.id = s."tenantId"
WHERE o.id IS NULL OR t.id IS NULL
UNION ALL
SELECT 'IdentityAccount.scope', ia.id
FROM "IdentityAccount" AS ia
LEFT JOIN "Subject" AS s
  ON s."organizationId" = ia."organizationId"
 AND s."tenantId" = ia."tenantId"
 AND s.id = ia."subjectId"
LEFT JOIN "ProviderConnection" AS pc
  ON pc."organizationId" = ia."organizationId"
 AND pc.id = ia."providerConnectionId"
WHERE s.id IS NULL OR pc.id IS NULL;

-- RLS posture for the canonical tenant-scoped tables.
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('Subject', 'IdentityAccount')
ORDER BY c.relname;

ROLLBACK;
