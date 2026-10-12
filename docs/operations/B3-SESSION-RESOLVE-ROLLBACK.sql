-- Rollback of 20261011200000_session_resolve_subject_account (B3). Run as the owner, in ONE
-- transaction:  psql -1 -v ON_ERROR_STOP=1 -f <this file>  (or prisma db execute --file).
-- Always lossless: it only restores the previous body of luxia_session_resolve (from
-- 20261011180000_organization_status_session_scope), same signature, grants kept.
CREATE OR REPLACE FUNCTION luxia_session_resolve(p_hash TEXT)
RETURNS TABLE (id TEXT, "organizationId" TEXT, "tenantId" TEXT, "subjectId" TEXT, "identityAccountId" TEXT,
  "expiresAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3), "lastSeenAt" TIMESTAMP(3), scope TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s."id", s."organizationId", s."tenantId", s."subjectId", s."identityAccountId",
         s."expiresAt", s."revokedAt", s."lastSeenAt", s."scope"::TEXT
  FROM "Session" s JOIN "Organization" o ON o."id" = s."organizationId"
  WHERE p_hash ~ '^[0-9a-f]{64}$' AND s."id" = p_hash AND o."status" = 'ACTIVE'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION luxia_session_resolve(TEXT) FROM PUBLIC;

DO $$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261011200000_session_resolve_subject_account';
  END IF;
END $$;
