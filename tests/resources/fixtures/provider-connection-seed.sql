-- Production-shaped data for the ProviderConnection lifecycle migration drill (F2). Applied after
-- self-onboarding-backfill-seed.sql and organization-status-seed.sql, on a scratch database migrated up to
-- (not including) the new migration. Legrand Tech then has, like Production: one Microsoft connection with
-- an account and sessions, one LUXIA_LOCAL connection with an account and an open session, each connection
-- scoped to the tenant.
INSERT INTO "ProviderConnectionTenantScope" ("organizationId", "tenantId", "providerConnectionId", "displayName", "createdAt") VALUES
  ('4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', '0b9d0b8e-3333-4c2a-9a55-000000000001', 'Microsoft Entra', '2026-09-01 10:00:00'),
  ('4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', '0b9d0b8e-3333-4c2a-9a55-000000000002', 'LUXIA Local', '2026-09-01 10:00:00');
INSERT INTO "IdentityAccount" ("id", "organizationId", "tenantId", "subjectId", "providerConnectionId", "externalObjectId", "createdAt", "updatedAt") VALUES
  ('0b9d0b8e-5555-4c2a-9a55-000000000002', '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', '0b9d0b8e-4444-4c2a-9a55-000000000001', '0b9d0b8e-3333-4c2a-9a55-000000000002', 'local-legrand-admin', '2026-09-02 10:00:00', '2026-09-02 10:00:00');
INSERT INTO "Session" ("id", "organizationId", "tenantId", "subjectId", "identityAccountId", "expiresAt", "createdAt", "lastSeenAt") VALUES
  (encode(sha256('drill-local-open'::bytea), 'hex'), '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', '0b9d0b8e-4444-4c2a-9a55-000000000001', '0b9d0b8e-5555-4c2a-9a55-000000000002', '2099-01-01 00:00:00', '2026-10-03 10:00:00', '2026-10-03 10:05:00');
