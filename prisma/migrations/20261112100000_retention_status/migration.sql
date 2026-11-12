-- Retention evidence (docs/engineering/PRIVATE-BETA-SCOPE.md, section 4.2): for R3, R4 and R6, the records that are
-- eligible now, those past their period plus 3 days (the backlog alert threshold of section 4.1) and the age in hours
-- of the oldest eligible one. The predicates are those of the purge functions (R3: 20261023130000; R4 and R6:
-- 20261025120000). Counts and ages only: no row content leaves the function. Each call is recorded in the owner-only
-- RetentionRun table, like the purges. The daily job calls it after the purges; a count above 0 in "overdue" is the
-- backlog alert.
CREATE FUNCTION luxia_retention_status() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');
  v_status jsonb;
BEGIN
  -- Row-level security is forced on the tables read here: an owner without BYPASSRLS would see no row.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'RETENTION_OWNER_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    -- R3: expired for more than 7 days; overdue after 7 + 3 days.
    'R3', (SELECT jsonb_build_object('eligible', count(*), 'overdue', count(*) FILTER (WHERE r.due < v_now - interval '10 days'),
             'oldestHours', coalesce(floor(extract(epoch FROM v_now - min(r.due)) / 3600)::integer, 0))
           FROM (SELECT "expiresAt" AS due FROM "LocalAuthChallenge" WHERE "expiresAt" < v_now - interval '7 days'
                 UNION ALL
                 SELECT "expiresAt" FROM "AuthTransaction" WHERE "expiresAt" < v_now - interval '7 days') r),
    -- R4: finished (accepted, revoked or expired) and created more than 30 days ago; overdue after 30 + 3 days.
    'R4', (SELECT jsonb_build_object('eligible', count(*), 'overdue', count(*) FILTER (WHERE r.due < v_now - interval '33 days'),
             'oldestHours', coalesce(floor(extract(epoch FROM v_now - min(r.due)) / 3600)::integer, 0))
           FROM (SELECT GREATEST(LEAST("acceptedAt", "revokedAt", "expiresAt"), "createdAt") AS due FROM "Invitation"
                 WHERE LEAST("acceptedAt", "revokedAt", "expiresAt") < v_now - interval '30 days'
                   AND "createdAt" < v_now - interval '30 days') r),
    -- R6: a person retired for more than 30 days whose names are not yet pseudonyms; overdue after 30 + 3 days.
    'R6', (SELECT jsonb_build_object('eligible', count(*), 'overdue', count(*) FILTER (WHERE r.due < v_now - interval '33 days'),
             'oldestHours', coalesce(floor(extract(epoch FROM v_now - min(r.due)) / 3600)::integer, 0))
           FROM (SELECT s."lifecycleChangedAt" AS due FROM "Subject" s
                 WHERE s."type" = 'HUMAN' AND s."lifecycleState" = 'RETIRED' AND s."lifecycleChangedAt" < v_now - interval '30 days'
                   AND (s."name" IS DISTINCT FROM 'Ancien membre ' || left(encode(sha256(convert_to(s."id", 'UTF8')), 'hex'), 8)
                     OR EXISTS (SELECT 1 FROM "IdentityAccount" a JOIN "LocalIdentity" l
                                  ON l."organizationId" = a."organizationId" AND l."tenantId" = a."tenantId" AND l."identityAccountId" = a."id"
                                WHERE a."organizationId" = s."organizationId" AND a."tenantId" = s."tenantId" AND a."subjectId" = s."id"
                                  AND l."principalName" IS DISTINCT FROM 'ANCIEN-MEMBRE-' || encode(sha256(convert_to(l."id", 'UTF8')), 'hex')))) r)
  ) INTO v_status;
  INSERT INTO "RetentionRun" ("enforced", "counts") VALUES (false, jsonb_build_object('mechanism', 'status') || v_status);
  RETURN v_status;
END $$;
REVOKE ALL ON FUNCTION luxia_retention_status() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION luxia_retention_status() TO app_user;
  END IF;
END $$;
