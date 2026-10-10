-- Business data shaped like Production before Customer Self-Onboarding v1: Legrand Tech (fixed id)
-- plus one other organization. Applied on a scratch database BEFORE the migration.
INSERT INTO "Organization" ("id", "name", "createdAt", "updatedAt") VALUES
  ('4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'Legrand Tech', '2026-09-01 10:00:00', '2026-09-02 11:00:00'),
  ('0b9d0b8e-1111-4c2a-9a55-000000000001', 'Other Org', '2026-09-03 10:00:00', '2026-09-03 10:00:00');
INSERT INTO "Tenant" ("id", "organizationId", "name", "createdAt", "updatedAt") VALUES
  ('c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'Production', '2026-09-01 10:00:00', '2026-09-01 10:00:00'),
  ('0b9d0b8e-2222-4c2a-9a55-000000000001', '0b9d0b8e-1111-4c2a-9a55-000000000001', 'Production', '2026-09-03 10:00:00', '2026-09-03 10:00:00');
INSERT INTO "ProviderConnection" ("id", "organizationId", "providerType", "externalScopeId", "name", "createdAt", "updatedAt") VALUES
  ('0b9d0b8e-3333-4c2a-9a55-000000000001', '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'MICROSOFT_ENTRA', 'entra-tenant-legrand', 'Microsoft Entra', '2026-09-01 10:00:00', '2026-09-01 10:00:00'),
  ('0b9d0b8e-3333-4c2a-9a55-000000000002', '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'LUXIA_LOCAL', 'luxia-local-legrand', 'LUXIA Local', '2026-09-01 10:00:00', '2026-09-01 10:00:00');
INSERT INTO "Subject" ("id", "organizationId", "tenantId", "type", "name", "createdAt", "updatedAt") VALUES
  ('0b9d0b8e-4444-4c2a-9a55-000000000001', '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', 'HUMAN', 'Admin Legrand', '2026-09-01 10:00:00', '2026-09-01 10:00:00'),
  ('0b9d0b8e-4444-4c2a-9a55-000000000002', '0b9d0b8e-1111-4c2a-9a55-000000000001', '0b9d0b8e-2222-4c2a-9a55-000000000001', 'HUMAN', 'Other Person', '2026-09-03 10:00:00', '2026-09-03 10:00:00');
INSERT INTO "IdentityAccount" ("id", "organizationId", "tenantId", "subjectId", "providerConnectionId", "externalObjectId", "createdAt", "updatedAt") VALUES
  ('0b9d0b8e-5555-4c2a-9a55-000000000001', '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', '0b9d0b8e-4444-4c2a-9a55-000000000001', '0b9d0b8e-3333-4c2a-9a55-000000000001', 'oid-legrand-admin', '2026-09-01 10:00:00', '2026-09-01 10:00:00');
