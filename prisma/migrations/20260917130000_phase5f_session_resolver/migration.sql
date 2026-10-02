-- Create Session Resolver Function for initial RLS bootstrap
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
SET search_path = public
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
