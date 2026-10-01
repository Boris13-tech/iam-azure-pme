-- LUXIA Production canonical identity bootstrap.
-- Idempotent, fail-closed, and deliberately excludes all legacy identities.

BEGIN;

DO $bootstrap_guard$
DECLARE
  conflicting_count bigint;
BEGIN
  SELECT count(*) INTO conflicting_count
  FROM "Organization"
  WHERE "id" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
     OR "name" = 'Legrand Tech';
  IF conflicting_count > 0 AND NOT EXISTS (
    SELECT 1 FROM "Organization"
    WHERE "id" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
      AND "name" = 'Legrand Tech'
  ) THEN
    RAISE EXCEPTION 'BOOTSTRAP_COLLISION: Organization';
  END IF;
  IF conflicting_count > 1 THEN
    RAISE EXCEPTION 'BOOTSTRAP_AMBIGUITY: Organization';
  END IF;

  SELECT count(*) INTO conflicting_count
  FROM "Tenant"
  WHERE "id" = 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'
     OR (
       "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
       AND "name" = 'Production'
     );
  IF conflicting_count > 0 AND NOT EXISTS (
    SELECT 1 FROM "Tenant"
    WHERE "id" = 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'
      AND "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
      AND "name" = 'Production'
  ) THEN
    RAISE EXCEPTION 'BOOTSTRAP_COLLISION: Tenant';
  END IF;
  IF conflicting_count > 1 THEN
    RAISE EXCEPTION 'BOOTSTRAP_AMBIGUITY: Tenant';
  END IF;

  SELECT count(*) INTO conflicting_count
  FROM "ProviderConnection"
  WHERE "id" = 'fde0704e-0d1c-4c47-b53e-f19a60f1748d'
     OR (
       "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
       AND "providerType" = 'MICROSOFT_ENTRA'
       AND "externalScopeId" = 'b8f6e875-25cd-4d75-90ec-e6dd206057e5'
     );
  IF conflicting_count > 0 AND NOT EXISTS (
    SELECT 1 FROM "ProviderConnection"
    WHERE "id" = 'fde0704e-0d1c-4c47-b53e-f19a60f1748d'
      AND "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
      AND "providerType" = 'MICROSOFT_ENTRA'
      AND "externalScopeId" = 'b8f6e875-25cd-4d75-90ec-e6dd206057e5'
      AND "name" = 'Microsoft Entra — Legrand Tech'
  ) THEN
    RAISE EXCEPTION 'BOOTSTRAP_COLLISION: ProviderConnection';
  END IF;
  IF conflicting_count > 1 THEN
    RAISE EXCEPTION 'BOOTSTRAP_AMBIGUITY: ProviderConnection';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Subject"
    WHERE "id" = '30a15eda-24d3-40ef-8705-11c2e6e1b929'
      AND NOT (
        "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
        AND "tenantId" = 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'
        AND "type" = 'HUMAN'
        AND "name" = 'Legrand Boris Ohandja Edimo'
        AND "lifecycleState" = 'ACTIVE'
      )
  ) THEN
    RAISE EXCEPTION 'BOOTSTRAP_COLLISION: Subject';
  END IF;

  SELECT count(*) INTO conflicting_count
  FROM "IdentityAccount"
  WHERE "id" = '211fd18b-62cd-4fdf-85b1-731ae3c1cf24'
     OR "externalObjectId" = 'e6ac473c-0e9a-4d04-bd02-4954b3caa6d2';
  IF conflicting_count > 0 AND NOT EXISTS (
    SELECT 1 FROM "IdentityAccount"
    WHERE "id" = '211fd18b-62cd-4fdf-85b1-731ae3c1cf24'
      AND "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
      AND "tenantId" = 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'
      AND "subjectId" = '30a15eda-24d3-40ef-8705-11c2e6e1b929'
      AND "providerConnectionId" = 'fde0704e-0d1c-4c47-b53e-f19a60f1748d'
      AND "externalObjectId" = 'e6ac473c-0e9a-4d04-bd02-4954b3caa6d2'
  ) THEN
    RAISE EXCEPTION 'BOOTSTRAP_COLLISION: IdentityAccount';
  END IF;
  IF conflicting_count > 1 THEN
    RAISE EXCEPTION 'BOOTSTRAP_AMBIGUITY: IdentityAccount';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "LegacyUserBridge" AS bridge
    JOIN "User" AS legacy_user ON legacy_user.id = bridge."legacyUserId"
    WHERE legacy_user.email IN ('admin@demo.com', 'jean.dupont@gmail.com')
  ) THEN
    RAISE EXCEPTION 'BOOTSTRAP_BLOCKED: demonstration user already has LegacyUserBridge';
  END IF;
END
$bootstrap_guard$;

INSERT INTO "Organization" ("id", "name", "createdAt", "updatedAt")
VALUES (
  '4841428a-80b4-4f07-bb3f-c94612dfd4a2',
  'Legrand Tech',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Tenant" ("id", "organizationId", "name", "createdAt", "updatedAt")
VALUES (
  'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914',
  '4841428a-80b4-4f07-bb3f-c94612dfd4a2',
  'Production',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

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
)
ON CONFLICT ("id") DO NOTHING;

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
)
ON CONFLICT ("id") DO NOTHING;

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
)
ON CONFLICT ("id") DO NOTHING;

DO $bootstrap_verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Organization"
    WHERE "id" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
      AND "name" = 'Legrand Tech'
  ) THEN RAISE EXCEPTION 'BOOTSTRAP_VERIFY_FAILED: Organization'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "Tenant"
    WHERE "id" = 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'
      AND "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
      AND "name" = 'Production'
  ) THEN RAISE EXCEPTION 'BOOTSTRAP_VERIFY_FAILED: Tenant'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ProviderConnection"
    WHERE "id" = 'fde0704e-0d1c-4c47-b53e-f19a60f1748d'
      AND "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
      AND "providerType" = 'MICROSOFT_ENTRA'
      AND "externalScopeId" = 'b8f6e875-25cd-4d75-90ec-e6dd206057e5'
  ) THEN RAISE EXCEPTION 'BOOTSTRAP_VERIFY_FAILED: ProviderConnection'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "Subject"
    WHERE "id" = '30a15eda-24d3-40ef-8705-11c2e6e1b929'
      AND "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
      AND "tenantId" = 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'
      AND "type" = 'HUMAN'
      AND "lifecycleState" = 'ACTIVE'
  ) THEN RAISE EXCEPTION 'BOOTSTRAP_VERIFY_FAILED: Subject'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "IdentityAccount"
    WHERE "id" = '211fd18b-62cd-4fdf-85b1-731ae3c1cf24'
      AND "organizationId" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2'
      AND "tenantId" = 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914'
      AND "subjectId" = '30a15eda-24d3-40ef-8705-11c2e6e1b929'
      AND "providerConnectionId" = 'fde0704e-0d1c-4c47-b53e-f19a60f1748d'
      AND "externalObjectId" = 'e6ac473c-0e9a-4d04-bd02-4954b3caa6d2'
  ) THEN RAISE EXCEPTION 'BOOTSTRAP_VERIFY_FAILED: IdentityAccount'; END IF;

  IF EXISTS (
    SELECT 1
    FROM "LegacyUserBridge" AS bridge
    JOIN "User" AS legacy_user ON legacy_user.id = bridge."legacyUserId"
    WHERE legacy_user.email IN ('admin@demo.com', 'jean.dupont@gmail.com')
  ) THEN RAISE EXCEPTION 'BOOTSTRAP_VERIFY_FAILED: demo bridge created'; END IF;
END
$bootstrap_verify$;

COMMIT;
