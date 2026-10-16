-- Sovereign Provider & Federation Layer, phase F4, slice S2: the data model of generic OIDC connections.
-- Design: docs/architecture/F4-GENERIC-OIDC-CONNECTIONS-DESIGN.md (section 5). Expand only: a new enum value, two new
-- tables that nothing reads yet, and two nullable or defaulted columns; no existing row changes.
-- Invariants held by the database itself:
--   * a generic OIDC configuration belongs to one OIDC_GENERIC connection of the same organization (composite key);
--   * it can be written only while that connection is DRAFT or TESTING, under the governance lock of every tenant of
--     the organization, and it is never deleted: once ACTIVE it is frozen (decision F4-3);
--   * its shape holds no secret: an exact HTTPS issuer on port 443, a client id, an allowed client authentication and
--     ID token algorithm, OIDC scopes; its configuration hash is computed by the database, never trusted from a client;
--   * a test run is append-only (T0 pattern) and records safe codes only;
--   * forced row-level security on both tables;
--   * an authorization transaction states its purpose; LINK and ACTIVATION_PROOF carry the subject that started it.
-- The new enum value is not used in this transaction (PostgreSQL requires its commit first): the guard compares text.
-- Prisma applies this file as one transaction. Rollback: docs/operations/PROVIDER-OIDC-CONFIGURATION-ROLLBACK.sql

SET lock_timeout = '5s';

ALTER TYPE "ProviderType" ADD VALUE IF NOT EXISTS 'OIDC_GENERIC';

-- ---------------------------------------------------------------------------
-- Per-connection OIDC configuration (no secret: the client secret is a ProviderSecretReference, F3).
-- ---------------------------------------------------------------------------
CREATE TABLE "ProviderOidcConfiguration" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "providerConnectionId" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientAuthMethod" TEXT NOT NULL DEFAULT 'client_secret_basic',
  "idTokenAlgorithm" TEXT NOT NULL DEFAULT 'RS256',
  "scopes" TEXT NOT NULL DEFAULT 'openid profile email',
  "configurationHash" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderOidcConfiguration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderOidcConfiguration_connection_fkey" FOREIGN KEY ("organizationId", "providerConnectionId")
    REFERENCES "ProviderConnection" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProviderOidcConfiguration_issuer" CHECK (
    length("issuer") <= 512
    -- a lower-case host name with at least two labels, the last one starting with a letter (so never an address)
    AND "issuer" ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z][a-z0-9-]*[a-z0-9](:443)?(/[A-Za-z0-9._~%!$&''()*+,;=:@-]+)*/?$'),
  -- No BETWEEN: PostgreSQL deparses it differently after a dump and a restore, which the backup check would flag.
  CONSTRAINT "ProviderOidcConfiguration_clientId" CHECK (length("clientId") >= 1 AND length("clientId") <= 255 AND "clientId" !~ '[[:space:][:cntrl:]]'),
  CONSTRAINT "ProviderOidcConfiguration_clientAuthMethod" CHECK ("clientAuthMethod" IN ('client_secret_basic', 'client_secret_post')),
  CONSTRAINT "ProviderOidcConfiguration_idTokenAlgorithm" CHECK ("idTokenAlgorithm" IN ('RS256', 'PS256', 'ES256')),
  CONSTRAINT "ProviderOidcConfiguration_scopes" CHECK ("scopes" ~ '^openid( [A-Za-z0-9_.:-]{1,64}){0,15}$')
);
CREATE UNIQUE INDEX "ProviderOidcConfiguration_providerConnectionId_key" ON "ProviderOidcConfiguration" ("providerConnectionId");
CREATE UNIQUE INDEX "ProviderOidcConfiguration_organizationId_providerConnectionId_key" ON "ProviderOidcConfiguration" ("organizationId", "providerConnectionId");
CREATE INDEX "ProviderOidcConfiguration_organizationId_idx" ON "ProviderOidcConfiguration" ("organizationId");

CREATE FUNCTION luxia_provider_oidc_configuration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_type TEXT;
  v_status TEXT;
  v_tenants INTEGER;
  v_unlocked INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PROVIDER_OIDC_CONFIGURATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."providerConnectionId" IS DISTINCT FROM OLD."providerConnectionId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt") THEN
    RAISE EXCEPTION 'PROVIDER_OIDC_CONFIGURATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  SELECT pc."providerType"::text, pc."status"::text INTO v_type, v_status
  FROM "ProviderConnection" pc WHERE pc."organizationId" = NEW."organizationId" AND pc."id" = NEW."providerConnectionId";
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'PROVIDER_OIDC_CONFIGURATION_CONNECTION' USING ERRCODE = '23503';
  END IF;
  IF v_type <> 'OIDC_GENERIC' THEN
    RAISE EXCEPTION 'PROVIDER_OIDC_CONFIGURATION_TYPE' USING ERRCODE = '23514';
  END IF;
  IF v_status NOT IN ('DRAFT', 'TESTING') THEN
    RAISE EXCEPTION 'PROVIDER_OIDC_CONFIGURATION_LOCKED' USING ERRCODE = '23514';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM pg_locks l
           WHERE l.locktype = 'advisory' AND l.granted AND l.pid = pg_backend_pid() AND l.objsubid = 1
             AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
             AND l.classid::bigint = ((h.k >> 32) & 4294967295) AND l.objid::bigint = (h.k & 4294967295)))
    INTO v_tenants, v_unlocked
  FROM "Tenant" t
  CROSS JOIN LATERAL (SELECT hashtextextended('resource-governance:' || NEW."organizationId" || ':' || t."id", 0) AS k) h
  WHERE t."organizationId" = NEW."organizationId";
  IF v_tenants = 0 OR v_unlocked > 0 THEN
    RAISE EXCEPTION 'GOVERNANCE_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  -- The hash the tests, the proof and the activation are bound to: computed here, never taken from a client.
  NEW."configurationHash" := encode(sha256(convert_to(concat_ws(chr(10), NEW."issuer", NEW."clientId", NEW."clientAuthMethod",
    NEW."idTokenAlgorithm", NEW."scopes"), 'UTF8')), 'hex');
  NEW."updatedAt" := (now() AT TIME ZONE 'UTC');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_provider_oidc_configuration_guard() FROM PUBLIC;
CREATE TRIGGER provider_oidc_configuration_guard BEFORE INSERT OR UPDATE OR DELETE ON "ProviderOidcConfiguration"
FOR EACH ROW EXECUTE FUNCTION luxia_provider_oidc_configuration_guard();

-- ---------------------------------------------------------------------------
-- Test runs and proof sign-ins: append-only, safe codes and counts only.
-- ---------------------------------------------------------------------------
CREATE TABLE "ProviderTestRun" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "providerConnectionId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "configurationHash" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "actorSubjectId" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderTestRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderTestRun_connection_fkey" FOREIGN KEY ("organizationId", "providerConnectionId")
    REFERENCES "ProviderConnection" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProviderTestRun_kind" CHECK ("kind" IN ('DISCOVERY', 'PROOF')),
  CONSTRAINT "ProviderTestRun_outcome" CHECK ("outcome" IN ('PASSED', 'FAILED')),
  CONSTRAINT "ProviderTestRun_reasonCode" CHECK ("reasonCode" ~ '^[A-Z0-9_]{1,64}$'),
  CONSTRAINT "ProviderTestRun_configurationHash" CHECK ("configurationHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ProviderTestRun_metadata" CHECK (jsonb_typeof("metadata") = 'object' AND pg_column_size("metadata") <= 8192)
);
CREATE INDEX "ProviderTestRun_connection_idx" ON "ProviderTestRun" ("organizationId", "providerConnectionId", "occurredAt");
CREATE TRIGGER provider_test_run_append_only BEFORE UPDATE OR DELETE ON "ProviderTestRun"
  FOR EACH ROW EXECUTE FUNCTION luxia_audit_append_only();
CREATE TRIGGER provider_test_run_append_only_truncate BEFORE TRUNCATE ON "ProviderTestRun"
  FOR EACH STATEMENT EXECUTE FUNCTION luxia_audit_append_only();

-- ---------------------------------------------------------------------------
-- Forced row-level security: an organization sees and writes its own rows only.
-- ---------------------------------------------------------------------------
ALTER TABLE "ProviderOidcConfiguration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderOidcConfiguration" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_oidc_configuration_organization_isolation" ON "ProviderOidcConfiguration"
USING ("organizationId" = current_setting('app.organization_id', true))
WITH CHECK ("organizationId" = current_setting('app.organization_id', true));
ALTER TABLE "ProviderTestRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderTestRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_test_run_organization_isolation" ON "ProviderTestRun"
USING ("organizationId" = current_setting('app.organization_id', true))
WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

-- ---------------------------------------------------------------------------
-- The purpose of an authorization transaction (sign-in, proven link, activation proof).
-- ---------------------------------------------------------------------------
ALTER TABLE "AuthTransaction" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'SIGN_IN', ADD COLUMN "subjectId" TEXT;
ALTER TABLE "AuthTransaction" ADD CONSTRAINT "AuthTransaction_purpose" CHECK (
  ("purpose" = 'SIGN_IN' AND "subjectId" IS NULL)
  OR ("purpose" IN ('LINK', 'ACTIVATION_PROOF') AND "subjectId" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Privileges: the runtime writes configurations (never deletes) and appends test runs.
-- ---------------------------------------------------------------------------
REVOKE ALL ON "ProviderOidcConfiguration", "ProviderTestRun" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON FUNCTION luxia_provider_oidc_configuration_guard() FROM app_user;
    GRANT SELECT, INSERT, UPDATE ON "ProviderOidcConfiguration" TO app_user;
    GRANT SELECT, INSERT ON "ProviderTestRun" TO app_user;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = '"ProviderOidcConfiguration"'::regclass)
     OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = '"ProviderTestRun"'::regclass) THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_OIDC_RLS';
  END IF;
END $$;

RESET lock_timeout;
