-- READ-ONLY. This script performs no INSERT, UPDATE, DELETE, DDL, or function call.
WITH planned("key", "entitlementId", "assignmentId") AS (
  VALUES
    ('subjects.read', '15dd30d5-403e-453d-a84a-90642825db33', 'c930b1b8-1a7b-4ccd-8b7d-5eafdc4cac65'),
    ('subjects.create', '9cba522a-3402-4bdb-b6c6-8bff7bcfc76b', '409bdea9-1811-4861-a756-926e08a41070'),
    ('subjects.update', 'a3031d22-80b4-4c6b-a4ab-eaf8683d2273', 'ba6fb47e-7a4f-4e45-8046-423b93afb062'),
    ('identity_accounts.read', '1d90c00c-caf4-420e-9a03-43d83cf6e5d4', '8466da2e-8288-4eaf-89f0-9fb60fdc1432'),
    ('identity_accounts.link', '72268f2d-817e-4e89-acb7-a5a11c16637c', '71ed6d02-23cd-4b63-8312-dad534562384'),
    ('identity_accounts.disable', '6766ea58-bae3-4467-8844-90e86063aaa9', '48825c00-4ee3-4b84-8ace-bdd3eea82eb6'),
    ('assignments.read', 'b3cbf5e8-8453-4fbb-a692-eb672da2a33f', '4dec6718-e364-48f1-9645-26e4a3d63ed8'),
    ('assignments.manage', '5e6eb1d0-497b-4e7d-9401-9119a7fbd78b', '9b42d264-1e20-48be-81e1-ccc129a5ad69'),
    ('sessions.read', '1f991443-950e-4114-87d9-483c8f82a36f', 'd426f877-c781-4668-88bb-95df05bdc7b4'),
    ('sessions.revoke', '75e15de2-662a-4d2b-ac48-7e81cc693dbb', 'db9e77f2-e9c4-49ab-a658-bb336f0464fd'),
    ('providers.read', '05193ecc-1a4d-47c5-8d12-0f23a31b8a96', '096444bd-070c-4a07-8b64-3986b1e8b13c'),
    ('providers.manage', '29a8ac6e-5d8a-43ea-a6ab-06f90d6d3710', '0576f6ad-ca5a-4c3b-adc4-47a0b74c6c58'),
    ('resources.read', '50260588-158c-4bc2-9905-3f52b6943062', '44ae2a6b-7d97-42aa-9ab2-9a5a5b759df1'),
    ('resources.manage', '6dd84098-d1d7-4168-a19f-bfe06bd71151', '84cf3d91-b056-4c10-9064-bd3400884d02'),
    ('audit.read', '514fa884-0038-4dfd-9750-b0f011581a70', '8dd44ab0-ee5b-4a2d-9cec-4e97d1e8fe28')
), scope AS (
  SELECT
    '4841428a-80b4-4f07-bb3f-c94612dfd4a2'::text AS "organizationId",
    'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'::text AS "tenantId",
    '30a15eda-24d3-40ef-8705-11c2e6e1b929'::text AS "subjectId"
)
SELECT
  p."key",
  p."entitlementId",
  p."assignmentId",
  EXISTS (SELECT 1 FROM "Entitlement" e WHERE e."id" = p."entitlementId") AS entitlement_id_collision,
  EXISTS (SELECT 1 FROM "Assignment" a WHERE a."id" = p."assignmentId") AS assignment_id_collision,
  EXISTS (
    SELECT 1 FROM "Entitlement" e, scope s
    WHERE e."organizationId" = s."organizationId"
      AND e."tenantId" = s."tenantId"
      AND e."key" = p."key"
  ) AS entitlement_key_exists,
  EXISTS (
    SELECT 1 FROM "Assignment" a, "Entitlement" e, scope s
    WHERE a."organizationId" = s."organizationId"
      AND a."tenantId" = s."tenantId"
      AND a."subjectId" = s."subjectId"
      AND a."status" = 'ACTIVE'
      AND a."entitlementId" = e."id"
      AND e."key" = p."key"
  ) AS active_assignment_exists
FROM planned p
ORDER BY p."key";

SELECT
  EXISTS (
    SELECT 1 FROM "Organization"
    WHERE "id" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
  ) AS organization_exists,
  EXISTS (
    SELECT 1 FROM "Tenant"
    WHERE "id" = 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'
      AND "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
  ) AS tenant_exists,
  EXISTS (
    SELECT 1 FROM "Subject"
    WHERE "id" = '30a15eda-24d3-40ef-8705-11c2e6e1b929'
      AND "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
      AND "tenantId" = 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'
      AND "type" = 'HUMAN'
      AND "lifecycleState" = 'ACTIVE'
  ) AS active_human_subject_exists,
  EXISTS (
    SELECT 1 FROM "ProviderConnection"
    WHERE "id" = 'fde0704e-0d1c-4c47-b53e-f19a60f1748d'
      AND "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
  ) AS provider_connection_exists,
  (SELECT count(*) FROM "LegacyUserBridge") AS legacy_bridge_count,
  (SELECT count(*) FROM "Role" WHERE "name" = 'LUXIA_ORG_ADMIN') AS legacy_role_name_collision;
