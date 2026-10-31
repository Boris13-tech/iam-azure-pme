-- R7 (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md): the operator erases a CLOSED organization at the
-- end of a pilot or after its closure. Every row of every table that carries the organization goes, in a fixed order,
-- children first; then the organization row. An organization with a LegacyUserBridge row is refused, and the bridge is
-- never deleted here: the legacy tables (User, UserRole, AuditLog) carry no organization and the bridge is their only
-- link, so they need their own procedure first. The append-only journal and the other guards keep refusing every
-- DELETE, except when a transaction-local marker names the row's organization, the statement runs as the table's
-- owner in its own session, and the organization is CLOSED. luxia_organization_erase, through the operator command,
-- is the supported and recorded path. It is not the only technically possible one: the database owner keeps its
-- intrinsic capabilities (setting that marker by hand, disabling triggers), which this gate limits by mistake only and
-- does not bind. The runtime role can call neither function. TRUNCATE stays refused.
-- Changed guard bodies are the previous ones plus that gate only (static test).

-- Locks: the two constraints below take SHARE ROW EXCLUSIVE on their table and on "Organization", which blocks writes on
-- them for the instant they hold it. A write in flight would make them wait with new writes queued behind, so they give
-- up after 5 seconds. Prisma applies this file as one transaction: nothing stays, and the gate can run it again.
SET lock_timeout = '5s';

-- Every table that carries an organization must make a writer wait for the erasure, and fail once it is done. These
-- two had no such link. NOT VALID: new rows are checked, existing rows are not scanned or changed.
ALTER TABLE "AuthTransaction" ADD CONSTRAINT "AuthTransaction_expectedOrganizationId_fkey"
  FOREIGN KEY ("expectedOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "AuthorizationShadowObservation" ADD CONSTRAINT "AuthorizationShadowObservation_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT NOT VALID;

CREATE TABLE "OrganizationErasure" (
  "id"             BIGSERIAL PRIMARY KEY,
  "organizationId" TEXT NOT NULL UNIQUE,
  "erasedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "counts"         JSONB NOT NULL,
  CONSTRAINT "OrganizationErasure_counts" CHECK (jsonb_typeof("counts") = 'object')
);
ALTER TABLE "OrganizationErasure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationErasure" FORCE ROW LEVEL SECURITY;

-- True only inside the operator's erasure of this organization: marker, table owner, CLOSED organization. The
-- owner is checked on both current_user and session_user: a SECURITY DEFINER function changes current_user but
-- never session_user, so a runtime role that sets the marker and calls a definer function still gets nothing.
CREATE FUNCTION luxia_erasure_allowed(p_organization_id TEXT, p_relation OID) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN p_organization_id IS NOT NULL
    AND current_setting('luxia.erasure_organization', true) = p_organization_id
    AND current_user = session_user
    AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = p_relation AND r.rolname = current_user)
    AND EXISTS (SELECT 1 FROM "Organization" o WHERE o."id" = p_organization_id AND o."status" = 'CLOSED');
END $$;
REVOKE ALL ON FUNCTION luxia_erasure_allowed(TEXT, OID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION luxia_review_immutable_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'REVIEW_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='AccessReviewItem' THEN
  IF OLD.decision<>'PENDING' OR (to_jsonb(NEW)-ARRAY['decision','reviewState','observedAssignmentState','decidedAt','justification']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['decision','reviewState','observedAssignmentState','decidedAt','justification']) THEN RAISE EXCEPTION 'REVIEW_IMMUTABLE'; END IF;
 ELSE
  IF OLD.status<>'OPEN' OR (to_jsonb(NEW)-ARRAY['status','completedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','completedAt']) THEN RAISE EXCEPTION 'REVIEW_IMMUTABLE'; END IF;
  IF NEW.status='COMPLETED' AND EXISTS(SELECT 1 FROM "AccessReviewItem" WHERE "campaignId"=OLD.id AND "organizationId"=OLD."organizationId" AND "tenantId"=OLD."tenantId" AND decision='PENDING') THEN RAISE EXCEPTION 'REVIEW_ITEMS_PENDING'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_resource_onboarding_evidence_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
  IF OLD."operation" LIKE 'RESOURCE.ONBOARDING.%'
     OR OLD."operation" LIKE 'RESOURCE.CAPABILITY.%'
     OR (TG_OP = 'UPDATE' AND
       (NEW."operation" LIKE 'RESOURCE.ONBOARDING.%' OR NEW."operation" LIKE 'RESOURCE.CAPABILITY.%'))
  THEN
    RAISE EXCEPTION 'RESOURCE_ONBOARDING_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_signup_code_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SIGNUP_CODE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('CONSUMED', 'REVOKED', 'EXPIRED')
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."codeHash" IS DISTINCT FROM OLD."codeHash"
     OR NEW."issuedBy" IS DISTINCT FROM OLD."issuedBy" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (NEW."status" = 'CONSUMED' AND OLD."expiresAt" <= (now() AT TIME ZONE 'UTC')) THEN
    RAISE EXCEPTION 'SIGNUP_CODE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_invitation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');
BEGIN
  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INVITATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."acceptedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL
       OR NEW."pendingChallengeHash" IS NOT NULL OR NEW."pendingExpiresAt" IS NOT NULL THEN
      RAISE EXCEPTION 'INVITATION_INVALID_INITIAL_STATE' USING ERRCODE = '23514';
    END IF;
    PERFORM luxia_organization_lock_active(NEW."organizationId");
    NEW."createdAt" := v_now;
    NEW."updatedAt" := v_now;
    IF NEW."issuedByOperatorChangeId" IS NOT NULL THEN
      IF NOT coalesce((SELECT r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user), false) THEN
        RAISE EXCEPTION 'INVITATION_OPERATOR_ONLY' USING ERRCODE = '42501';
      END IF;
      NEW."expiresAt" := v_now + interval '24 hours';
    ELSE
      NEW."expiresAt" := v_now + interval '7 days';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."acceptedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."subjectId" IS DISTINCT FROM OLD."subjectId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR NEW."role" IS DISTINCT FROM OLD."role"
     OR NEW."invitedBySubjectId" IS DISTINCT FROM OLD."invitedBySubjectId"
     OR NEW."issuedByOperatorChangeId" IS DISTINCT FROM OLD."issuedByOperatorChangeId"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'INVITATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."acceptedAt" IS NOT NULL AND OLD."expiresAt" <= v_now THEN
    RAISE EXCEPTION 'INVITATION_EXPIRED' USING ERRCODE = '23514';
  END IF;
  IF NEW."acceptedAt" IS NOT NULL
     OR (NEW."pendingChallengeHash" IS NOT NULL AND NEW."pendingChallengeHash" IS DISTINCT FROM OLD."pendingChallengeHash") THEN
    PERFORM luxia_organization_lock_active(NEW."organizationId");
  END IF;
  IF NEW."acceptedAt" IS NOT NULL AND NEW."issuedByOperatorChangeId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "CanonicalAdminAuditEvent" e
    WHERE e."organizationId" = NEW."organizationId" AND e."tenantId" = NEW."tenantId"
      AND e."changeId" = NEW."issuedByOperatorChangeId" AND e."operation" = 'BREAK_GLASS.RECOVERY_INVITATION.ISSUE'
      AND e."result" = 'SUCCESS' AND e."metadata"->>'invitationId' = NEW."id") THEN
    RAISE EXCEPTION 'INVITATION_OPERATOR_AUTHORITY_MISSING' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_organization_domain_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ORGANIZATION_DOMAIN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM luxia_organization_lock_active(NEW."organizationId");
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."domain" IS DISTINCT FROM OLD."domain"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ORGANIZATION_DOMAIN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'VERIFIED' AND OLD."status" IS DISTINCT FROM 'VERIFIED' THEN
    PERFORM luxia_organization_lock_active(NEW."organizationId");
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_recovery_code_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_usable INTEGER;
BEGIN
  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RECOVERY_CODE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."usedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."batchId" IS NULL THEN
      RAISE EXCEPTION 'RECOVERY_CODE_INVALID_INITIAL_STATE' USING ERRCODE = '23514';
    END IF;
    PERFORM luxia_organization_lock_active(NEW."organizationId");
    -- Concurrent batches of one account are serialized on its local identity row, so the count
    -- below sees every committed code.
    PERFORM 1 FROM "LocalIdentity"
      WHERE "organizationId" = NEW."organizationId" AND "tenantId" = NEW."tenantId" AND "identityAccountId" = NEW."identityAccountId"
      FOR NO KEY UPDATE;
    SELECT count(*) INTO v_usable FROM "LocalRecoveryCode"
      WHERE "organizationId" = NEW."organizationId" AND "tenantId" = NEW."tenantId" AND "identityAccountId" = NEW."identityAccountId"
        AND "usedAt" IS NULL AND "revokedAt" IS NULL;
    IF v_usable >= 10 THEN
      RAISE EXCEPTION 'RECOVERY_CODE_LIMIT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."usedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'RECOVERY_CODE_FROZEN' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."id", NEW."organizationId", NEW."tenantId", NEW."identityAccountId", NEW."codeHash", NEW."batchId", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD."id", OLD."organizationId", OLD."tenantId", OLD."identityAccountId", OLD."codeHash", OLD."batchId", OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'RECOVERY_CODE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF (NEW."usedAt" IS NULL) = (NEW."revokedAt" IS NULL) THEN
    -- Neither changed (no-op update) or both in one statement: refused either way.
    RAISE EXCEPTION 'RECOVERY_CODE_ONE_CHANGE' USING ERRCODE = '23514';
  END IF;
  IF NEW."usedAt" IS NOT NULL THEN
    PERFORM luxia_organization_lock_active(NEW."organizationId"); -- a code is consumed only for an ACTIVE organization
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION luxia_audit_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY' USING ERRCODE = '23514',
    DETAIL = format('%s on %s is not allowed: the audit trail is append-only', TG_OP, TG_TABLE_NAME);
END $$;

CREATE OR REPLACE FUNCTION luxia_provider_connection_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_tenants INTEGER;
  v_unlocked INTEGER;
BEGIN
  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
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

CREATE OR REPLACE FUNCTION luxia_provider_secret_reference_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_org TEXT;
  v_tenants INTEGER;
  v_unlocked INTEGER;
BEGIN
  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
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

-- The erasure. Owner only (operator procedure, plan and confirmation in scripts/operators/organization-erasure.ts).
-- Returns the number of rows deleted per table. Refuses anything but a CLOSED organization, and fails if any row of
-- the organization remains in any table with an "organizationId" column (a table added later is caught here).
CREATE FUNCTION luxia_organization_erase(p_organization_id TEXT) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_tables CONSTANT TEXT[] := ARRAY[
    'AccessReviewItem',
    'AccessReviewCampaign',
    'SoDRule',
    'SoDPolicy',
    'Assignment',
    'Entitlement',
    'ResourceScopeMember',
    'ResourceScope',
    'ProviderSecretReference',
    'ProviderConnectionTenantScope',
    'Resource',
    'Session',
    'AuthenticationEvidence',
    'LocalAuthChallenge',
    'LocalRecoveryCode',
    'LocalAuthenticator',
    'LocalIdentity',
    'Invitation',
    'IdentityRecoveryApproval',
    'IdentityRecoveryCeremony',
    'IdentityPortabilityConflict',
    'IdentityPortabilityReceipt',
    'CredentialReenrollmentRequirement',
    'IdentityContinuityConflict',
    'IdentityContinuityEvent',
    'IdentityAssuranceSnapshot',
    'OfflineIdentityChallenge',
    'IdentityContinuityState',
    'TrustAnchorVersion',
    'CryptoKeyVersion',
    'ProviderIdentityCollision',
    'IdentityAccount',
    'AuthorizationShadowObservation',
    'CanonicalAdminAuditEvent',
    'OrganizationDomain',
    'Subject',
    'ProviderConnection',
    'Tenant',
    'SignupCode'];
  v_table TEXT;
  v_count BIGINT;
  v_counts jsonb := '{}'::jsonb;
  v_status "OrganizationStatus";
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'ERASURE_REQUIRES_BYPASSRLS' USING ERRCODE = '42501';
  END IF;
  SELECT o."status" INTO v_status FROM "Organization" o WHERE o."id" = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERASURE_ORGANIZATION_UNKNOWN' USING ERRCODE = '23514';
  END IF;
  IF v_status <> 'CLOSED' THEN
    RAISE EXCEPTION 'ERASURE_ORGANIZATION_NOT_CLOSED' USING ERRCODE = '23514';
  END IF;
  -- The bridge is the only link to the legacy tables, which have no organization column: fail closed, keep the link.
  -- It is in no delete list: one committed after this check stops the erasure (foreign key on Subject, or the
  -- completeness check below), and the whole transaction rolls back.
  IF EXISTS (SELECT 1 FROM "LegacyUserBridge" b WHERE b."organizationId" = p_organization_id) THEN
    RAISE EXCEPTION 'ERASURE_LEGACY_DATA_PRESENT' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('luxia.erasure_organization', p_organization_id, true);
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('DELETE FROM %I WHERE "organizationId" = $1', v_table) USING p_organization_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object(v_table, v_count);
  END LOOP;
  DELETE FROM "AuthTransaction" WHERE "expectedOrganizationId" = p_organization_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('AuthTransaction', v_count);
  FOR v_table IN SELECT c.table_name::text FROM information_schema.columns c JOIN information_schema.tables t
                   ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                 WHERE c.table_schema = 'public' AND c.column_name = 'organizationId' AND t.table_type = 'BASE TABLE'
                   AND c.table_name <> 'OrganizationErasure' LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "organizationId" = $1', v_table) INTO v_count USING p_organization_id;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'ERASURE_INCOMPLETE' USING ERRCODE = '23514', DETAIL = v_table;
    END IF;
  END LOOP;
  DELETE FROM "Organization" WHERE "id" = p_organization_id;
  v_counts := v_counts || jsonb_build_object('Organization', 1);
  PERFORM set_config('luxia.erasure_organization', '', true);
  INSERT INTO "OrganizationErasure" ("organizationId", "counts") VALUES (p_organization_id, v_counts);
  RETURN v_counts;
END $$;
REVOKE ALL ON FUNCTION luxia_organization_erase(TEXT) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON FUNCTION luxia_erasure_allowed(TEXT, OID) FROM app_user;
    REVOKE ALL ON FUNCTION luxia_organization_erase(TEXT) FROM app_user;
    REVOKE ALL ON "OrganizationErasure" FROM app_user;
    REVOKE ALL ON SEQUENCE "OrganizationErasure_id_seq" FROM app_user;
  END IF;
END $$;

RESET lock_timeout;
