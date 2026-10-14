-- Sovereign Provider & Federation Layer, phase F2: ProviderConnection lifecycle and sign-in kill switch.
-- Design: docs/architecture/SOVEREIGN-PROVIDER-FEDERATION-LAYER-DESIGN.md (4.4, 4.8) and
-- docs/architecture/F2-PROVIDER-CONNECTION-LIFECYCLE.md.
-- Expand only: the application deployed before this migration keeps working unchanged (it never sets or
-- reads a status, never deletes a connection, and every existing and new row is ACTIVE by default).
-- Row-level security on ProviderConnection is a separate, later migration (F2 M2), applied only once the
-- application that reads connections inside a tenant scope is in Production.
-- Prisma applies this file as one transaction. Rollback: docs/operations/PROVIDER-CONNECTION-LIFECYCLE-ROLLBACK.sql

SET lock_timeout = '5s';
LOCK TABLE "ProviderConnection", "Session" IN ACCESS EXCLUSIVE MODE;
SELECT set_config('luxia.migration_connections', (SELECT count(*) FROM "ProviderConnection")::text, true);
SELECT set_config('luxia.migration_open_sessions', (SELECT count(*) FROM "Session" WHERE "revokedAt" IS NULL)::text, true);

-- ---------------------------------------------------------------------------
-- Schema and backfill: a metadata-only default, no row is rewritten. Every existing connection is ACTIVE.
-- ---------------------------------------------------------------------------
CREATE TYPE "ProviderConnectionStatus" AS ENUM ('DRAFT', 'TESTING', 'ACTIVE', 'DISABLED', 'QUARANTINED');
ALTER TABLE "ProviderConnection"
  ADD COLUMN "status" "ProviderConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "statusChangedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Status guard. A connection is never deleted; its identity (id, organization, type, creation) never
-- changes; its external scope changes only before it is first activated. A new connection is DRAFT or
-- ACTIVE. LUXIA_LOCAL is always ACTIVE (rule R3: local sign-in and recovery never depend on a switch).
-- Allowed transitions only, each under the governance lock of every tenant of the organization.
-- ---------------------------------------------------------------------------
CREATE FUNCTION luxia_provider_connection_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_tenants INTEGER;
  v_unlocked INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('DRAFT', 'ACTIVE') OR (NEW."providerType" = 'LUXIA_LOCAL' AND NEW."status" <> 'ACTIVE') THEN
      RAISE EXCEPTION 'PROVIDER_CONNECTION_STATUS_INITIAL' USING ERRCODE = '23514';
    END IF;
    NEW."statusChangedAt" := NULL;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."providerType" IS DISTINCT FROM OLD."providerType" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."externalScopeId" IS DISTINCT FROM OLD."externalScopeId" AND OLD."status" NOT IN ('DRAFT', 'TESTING') THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_SCOPE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    NEW."statusChangedAt" := OLD."statusChangedAt";
    RETURN NEW;
  END IF;
  IF OLD."providerType" = 'LUXIA_LOCAL' THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_LOCAL_ALWAYS_ACTIVE' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'TESTING')
       OR (OLD."status" = 'TESTING' AND NEW."status" = 'ACTIVE')
       OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('DISABLED', 'QUARANTINED'))
       OR (OLD."status" = 'DISABLED' AND NEW."status" IN ('ACTIVE', 'QUARANTINED'))
       OR (OLD."status" = 'QUARANTINED' AND NEW."status" = 'DISABLED')) THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_STATUS_TRANSITION' USING ERRCODE = '23514';
  END IF;
  -- Checked, never taken here (taking it after the row lock would invert the lock order), as in B3.
  -- A bigint advisory key shows its high half in classid, its low half in objid, objsubid = 1.
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
  NEW."statusChangedAt" := (now() AT TIME ZONE 'UTC');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_provider_connection_guard() FROM PUBLIC;
CREATE TRIGGER provider_connection_guard BEFORE INSERT OR UPDATE OR DELETE ON "ProviderConnection"
FOR EACH ROW EXECUTE FUNCTION luxia_provider_connection_guard();

-- ---------------------------------------------------------------------------
-- Quarantine completeness, checked at commit: a QUARANTINED connection has no open session left
-- (decision D3). SECURITY DEFINER so that it sees every tenant's sessions, whatever the caller's scope;
-- it is a trigger function only, executable by nobody.
-- ---------------------------------------------------------------------------
CREATE FUNCTION luxia_provider_connection_effects() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ProviderConnection" pc WHERE pc."id" = NEW."id" AND pc."status" = 'QUARANTINED')
     AND EXISTS (SELECT 1 FROM "Session" s JOIN "IdentityAccount" ia ON ia."organizationId" = s."organizationId" AND ia."id" = s."identityAccountId"
                 WHERE ia."providerConnectionId" = NEW."id" AND s."revokedAt" IS NULL) THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_QUARANTINE_INCOMPLETE_SESSIONS' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION luxia_provider_connection_effects() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER provider_connection_effects AFTER UPDATE OF "status" ON "ProviderConnection"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION luxia_provider_connection_effects();

-- ---------------------------------------------------------------------------
-- Sign-in kill switch, in the core: a session is created only through an ACTIVE connection. The
-- connection row is share-locked, so a status change waits until the sign-in commits, then its effects
-- see the new session (same lock discipline as B3: organization row first, then the connection).
-- Runtime entry point (granted to app_user); the trigger below calls it for every new session.
-- ---------------------------------------------------------------------------
CREATE FUNCTION luxia_provider_connection_lock_active(p_organization_id TEXT, p_identity_account_id TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_status "ProviderConnectionStatus";
BEGIN
  SELECT pc."status" INTO v_status
  FROM "IdentityAccount" ia
  JOIN "ProviderConnection" pc ON pc."organizationId" = ia."organizationId" AND pc."id" = ia."providerConnectionId"
  WHERE ia."organizationId" = p_organization_id AND ia."id" = p_identity_account_id
  FOR SHARE OF pc;
  IF v_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'PROVIDER_CONNECTION_NOT_ACTIVE' USING ERRCODE = '23514';
  END IF;
END $$;
REVOKE ALL ON FUNCTION luxia_provider_connection_lock_active(TEXT, TEXT) FROM PUBLIC;

-- Fires after session_guard (alphabetical order), so the organization row is locked first.
CREATE FUNCTION luxia_session_connection_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM luxia_provider_connection_lock_active(NEW."organizationId", NEW."identityAccountId");
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_session_connection_guard() FROM PUBLIC;
CREATE TRIGGER session_guard_provider_connection BEFORE INSERT ON "Session"
FOR EACH ROW EXECUTE FUNCTION luxia_session_connection_guard();

-- ---------------------------------------------------------------------------
-- Runtime grants. In CI app_user is created after migrations (see ci.yml bootstrap).
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON FUNCTION luxia_provider_connection_guard() FROM app_user;
    REVOKE ALL ON FUNCTION luxia_provider_connection_effects() FROM app_user;
    REVOKE ALL ON FUNCTION luxia_session_connection_guard() FROM app_user;
    GRANT EXECUTE ON FUNCTION luxia_provider_connection_lock_active(TEXT, TEXT) TO app_user;
    -- A connection is never deleted (the guard refuses it too).
    REVOKE DELETE, TRUNCATE ON "ProviderConnection" FROM app_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Post-conditions: fail the migration if the backfill is not exactly as designed.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "ProviderConnection" WHERE "status" <> 'ACTIVE' OR "statusChangedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_CONNECTION_STATUS';
  END IF;
  IF (SELECT count(*) FROM "ProviderConnection")::text <> current_setting('luxia.migration_connections') THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_CONNECTIONS';
  END IF;
  IF (SELECT count(*) FROM "Session" WHERE "revokedAt" IS NULL)::text <> current_setting('luxia.migration_open_sessions') THEN
    RAISE EXCEPTION 'MIGRATION_ASSERTION_OPEN_SESSIONS';
  END IF;
END $$;

RESET lock_timeout;
