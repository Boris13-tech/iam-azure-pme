-- Sovereign Provider & Federation Layer, phase F3: per-connection secret REFERENCES (never values).
-- Design: docs/architecture/F3-SECRET-STORE-DESIGN.md (sections 2 and 8). Expand only: a new table that nothing reads
-- yet; the application deployed before this migration is unaffected.
-- Invariants held by the database itself:
--   * a reference points into a vault (store 'azure-key-vault', locator akv://<vault>/<name>), never at the process
--     environment, and its shape cannot hold a secret value;
--   * the active version is pinned (32 hex); a rotation only promotes the recorded candidate;
--   * one live reference per connection and purpose; a reference is revoked, never deleted; a revoked one never changes;
--   * every write runs under the governance lock of every tenant of the organization; forced row-level security.
-- Prisma applies this file as one transaction. Rollback: docs/operations/PROVIDER-SECRET-REFERENCE-ROLLBACK.sql

SET lock_timeout = '5s';

CREATE TYPE "ProviderSecretPurpose" AS ENUM ('OIDC_CLIENT', 'DIRECTORY');

CREATE TABLE "ProviderSecretReference" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "providerConnectionId" TEXT NOT NULL,
  "purpose" "ProviderSecretPurpose" NOT NULL,
  "store" TEXT NOT NULL,
  "locator" TEXT NOT NULL,
  "activeVersion" TEXT NOT NULL,
  "candidateVersion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotatedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "ProviderSecretReference_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderSecretReference_connection_fkey" FOREIGN KEY ("organizationId", "providerConnectionId")
    REFERENCES "ProviderConnection" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProviderSecretReference_store" CHECK ("store" = 'azure-key-vault'),
  CONSTRAINT "ProviderSecretReference_locator" CHECK (
    "locator" ~ '^akv://[a-z][a-z0-9-]{1,22}[a-z0-9]/[0-9A-Za-z-]{1,127}$'
    AND position('--' IN split_part(substr("locator", 7), '/', 1)) = 0),
  CONSTRAINT "ProviderSecretReference_versions" CHECK (
    "activeVersion" ~ '^[0-9a-f]{32}$'
    AND ("candidateVersion" IS NULL OR ("candidateVersion" ~ '^[0-9a-f]{32}$' AND "candidateVersion" <> "activeVersion")))
);
CREATE UNIQUE INDEX "ProviderSecretReference_live_key" ON "ProviderSecretReference" ("organizationId", "providerConnectionId", "purpose")
  WHERE "revokedAt" IS NULL;
CREATE INDEX "ProviderSecretReference_connection_idx" ON "ProviderSecretReference" ("organizationId", "providerConnectionId");

-- ---------------------------------------------------------------------------
-- Guard: never deleted; identity immutable; a revoked reference is frozen; the active version changes only by promoting
-- the candidate; every write under the governance lock of every tenant of the organization (checked, never taken here).
-- ---------------------------------------------------------------------------
CREATE FUNCTION luxia_provider_secret_reference_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_org TEXT;
  v_tenants INTEGER;
  v_unlocked INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PROVIDER_SECRET_REFERENCE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROVIDER_SECRET_REFERENCE_REVOKED' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW."id", NEW."organizationId", NEW."providerConnectionId", NEW."purpose", NEW."store", NEW."locator", NEW."createdAt")
       IS DISTINCT FROM ROW(OLD."id", OLD."organizationId", OLD."providerConnectionId", OLD."purpose", OLD."store", OLD."locator", OLD."createdAt") THEN
      RAISE EXCEPTION 'PROVIDER_SECRET_REFERENCE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF NEW."activeVersion" IS DISTINCT FROM OLD."activeVersion" THEN
      IF OLD."candidateVersion" IS NULL OR NEW."activeVersion" IS DISTINCT FROM OLD."candidateVersion" OR NEW."candidateVersion" IS NOT NULL THEN
        RAISE EXCEPTION 'PROVIDER_SECRET_REFERENCE_PROMOTION_ONLY' USING ERRCODE = '23514';
      END IF;
      NEW."rotatedAt" := (now() AT TIME ZONE 'UTC');
    ELSE
      NEW."rotatedAt" := OLD."rotatedAt";
    END IF;
    IF NEW."revokedAt" IS NOT NULL THEN
      NEW."revokedAt" := (now() AT TIME ZONE 'UTC');
    END IF;
  ELSE
    IF NEW."revokedAt" IS NOT NULL OR NEW."rotatedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'PROVIDER_SECRET_REFERENCE_INITIAL' USING ERRCODE = '23514';
    END IF;
  END IF;
  v_org := NEW."organizationId";
  SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM pg_locks l
           WHERE l.locktype = 'advisory' AND l.granted AND l.pid = pg_backend_pid() AND l.objsubid = 1
             AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
             AND l.classid::bigint = ((h.k >> 32) & 4294967295) AND l.objid::bigint = (h.k & 4294967295)))
    INTO v_tenants, v_unlocked
  FROM "Tenant" t
  CROSS JOIN LATERAL (SELECT hashtextextended('resource-governance:' || v_org || ':' || t."id", 0) AS k) h
  WHERE t."organizationId" = v_org;
  IF v_tenants = 0 OR v_unlocked > 0 THEN
    RAISE EXCEPTION 'GOVERNANCE_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_provider_secret_reference_guard() FROM PUBLIC;
CREATE TRIGGER provider_secret_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON "ProviderSecretReference"
FOR EACH ROW EXECUTE FUNCTION luxia_provider_secret_reference_guard();

-- ---------------------------------------------------------------------------
-- Forced row-level security: an organization sees and writes its own references only.
-- ---------------------------------------------------------------------------
ALTER TABLE "ProviderSecretReference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderSecretReference" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_secret_reference_organization_isolation" ON "ProviderSecretReference"
USING ("organizationId" = current_setting('app.organization_id', true))
WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON FUNCTION luxia_provider_secret_reference_guard() FROM app_user;
    GRANT SELECT, INSERT, UPDATE ON "ProviderSecretReference" TO app_user;
  END IF;
END $$;

RESET lock_timeout;
