-- First Admin / Break-glass v1, B3: the canonical session resolver also refuses a session whose
-- subject is not ACTIVE or whose identity account is not ACTIVE (design section 5, A2). It stays the
-- only implementation: resolve_session wraps it and inherits the rule.
-- Same signature: CREATE OR REPLACE keeps the app_user grant. No table, no data change.
-- Rollback: docs/operations/B3-SESSION-RESOLVE-ROLLBACK.sql
CREATE OR REPLACE FUNCTION luxia_session_resolve(p_hash TEXT)
RETURNS TABLE (id TEXT, "organizationId" TEXT, "tenantId" TEXT, "subjectId" TEXT, "identityAccountId" TEXT,
  "expiresAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3), "lastSeenAt" TIMESTAMP(3), scope TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s."id", s."organizationId", s."tenantId", s."subjectId", s."identityAccountId",
         s."expiresAt", s."revokedAt", s."lastSeenAt", s."scope"::TEXT
  FROM "Session" s
  JOIN "Organization" o ON o."id" = s."organizationId"
  JOIN "Subject" su ON su."organizationId" = s."organizationId" AND su."tenantId" = s."tenantId" AND su."id" = s."subjectId"
  JOIN "IdentityAccount" ia ON ia."organizationId" = s."organizationId" AND ia."tenantId" = s."tenantId"
    AND ia."id" = s."identityAccountId" AND ia."subjectId" = s."subjectId"
  WHERE p_hash ~ '^[0-9a-f]{64}$' AND s."id" = p_hash
    AND o."status" = 'ACTIVE' AND su."lifecycleState" = 'ACTIVE' AND ia."status" = 'ACTIVE'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION luxia_session_resolve(TEXT) FROM PUBLIC;
