-- Sessions, an open invitation and a pending domain shaped like Production, for the
-- Organization.status / Session.scope migration drill. Applied after
-- self-onboarding-backfill-seed.sql, on a scratch database migrated up to (not including) the new
-- migration. Session ids are SHA-256 hex, like real hashed cookie tokens.
INSERT INTO "Session" ("id", "organizationId", "tenantId", "subjectId", "identityAccountId", "expiresAt", "createdAt", "lastSeenAt") VALUES
  (encode(sha256('drill-open'::bytea), 'hex'), '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', '0b9d0b8e-4444-4c2a-9a55-000000000001', '0b9d0b8e-5555-4c2a-9a55-000000000001', '2099-01-01 00:00:00', '2026-10-01 10:00:00', '2026-10-01 10:05:00'),
  (encode(sha256('drill-revoked'::bytea), 'hex'), '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', '0b9d0b8e-4444-4c2a-9a55-000000000001', '0b9d0b8e-5555-4c2a-9a55-000000000001', '2099-01-01 00:00:00', '2026-10-02 10:00:00', NULL),
  (encode(sha256('drill-expired'::bytea), 'hex'), '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', '0b9d0b8e-4444-4c2a-9a55-000000000001', '0b9d0b8e-5555-4c2a-9a55-000000000001', '2026-09-01 00:00:00', '2026-08-31 10:00:00', NULL);
UPDATE "Session" SET "revokedAt" = '2026-10-02 11:00:00' WHERE "id" = encode(sha256('drill-revoked'::bytea), 'hex');
INSERT INTO "Invitation" ("id", "organizationId", "tenantId", "subjectId", "tokenHash", "role", "invitedBySubjectId", "createdAt", "expiresAt", "updatedAt") VALUES
  ('0b9d0b8e-6666-4c2a-9a55-000000000001', '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', '0b9d0b8e-4444-4c2a-9a55-000000000001', encode(sha256('drill-invitation'::bytea), 'hex'), 'MEMBER', '0b9d0b8e-4444-4c2a-9a55-000000000001', now(), now(), now());
INSERT INTO "OrganizationDomain" ("id", "organizationId", "tenantId", "domain", "challengeHash", "challengeExpiresAt", "updatedAt") VALUES
  ('0b9d0b8e-7777-4c2a-9a55-000000000001', '4841428a-80b4-4f07-bb3f-c94612dfd4a2', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', 'drill.legrand.example', encode(sha256('drill-challenge'::bytea), 'hex'), '2099-01-01 00:00:00', now());
