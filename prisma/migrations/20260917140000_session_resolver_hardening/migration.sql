-- 1. Redefine the session resolver to be hardened
CREATE OR REPLACE FUNCTION resolve_session(p_hash TEXT)
RETURNS TABLE (
  id TEXT,
  "organizationId" TEXT,
  "tenantId" TEXT,
  "subjectId" TEXT,
  "identityAccountId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3)
)
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s."organizationId", s."tenantId", s."subjectId", s."identityAccountId", s."expiresAt", s."revokedAt", s."lastSeenAt"
  FROM "Session" s
  WHERE s.id = p_hash
  LIMIT 1;
END;
$$;

-- 2. Revoke execute from PUBLIC
REVOKE EXECUTE ON FUNCTION resolve_session(TEXT) FROM PUBLIC;

-- 3. Grant execute exclusively to the runtime role
GRANT EXECUTE ON FUNCTION resolve_session(TEXT) TO app_user;
