-- Customer Self-Onboarding v1 (scope: docs/product/CUSTOMER-SELF-ONBOARDING-V1-SCOPE.md, sections 9 and 10).
-- Adds Organization.slug and five tables: SignupCode, OrganizationDomain, Invitation, RateLimitBucket,
-- RateLimitConfig. Forced RLS on all five. No existing row is changed except Organization.slug.
-- Rollback / forward-fix: docs/operations/CUSTOMER-SELF-ONBOARDING-V1-MIGRATION.md

-- CreateEnum
CREATE TYPE "SignupCodeStatus" AS ENUM ('ISSUED', 'RESERVED', 'CONSUMED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OrganizationDomainStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'LOST');

-- CreateEnum
CREATE TYPE "InvitationRole" AS ENUM ('MEMBER', 'ADMIN');

-- Organization.slug. Explicit backfill BEFORE NOT NULL (requirement 12): Legrand Tech gets
-- 'legrand-tech'; any other existing organization gets a random 'org-' slug. Only the new
-- column is written; no other column or table is touched (updatedAt included).
ALTER TABLE "Organization" ADD COLUMN "slug" TEXT;
UPDATE "Organization" SET "slug" = 'legrand-tech' WHERE "id" = '4841428a-80b4-4f07-bb3f-c94612dfd4a2';
UPDATE "Organization" SET "slug" = 'org-' || substr(md5(gen_random_uuid()::text || "id"), 1, 16) WHERE "slug" IS NULL;
ALTER TABLE "Organization" ALTER COLUMN "slug" SET DEFAULT ('org-'::text || substr(md5(((gen_random_uuid())::text || (clock_timestamp())::text)), 1, 16));
ALTER TABLE "Organization" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_slug_format"
  CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' AND position('--' in "slug") = 0);

-- CreateTable
CREATE TABLE "SignupCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" "SignupCodeStatus" NOT NULL DEFAULT 'ISSUED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "note" TEXT,
    "reservedAt" TIMESTAMP(3),
    "pendingChallengeHash" TEXT,
    "pendingExpiresAt" TIMESTAMP(3),
    "pendingPayload" JSONB,
    "consumedAt" TIMESTAMP(3),
    "organizationId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignupCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationDomain" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" "OrganizationDomainStatus" NOT NULL DEFAULT 'PENDING',
    "challengeHash" TEXT NOT NULL,
    "challengeExpiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "role" "InvitationRole" NOT NULL,
    "invitedBySubjectId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + '7 days'::interval),
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "pendingChallengeHash" TEXT,
    "pendingExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "keyHash" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("keyHash","windowStart")
);

-- CreateTable
CREATE TABLE "RateLimitConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "pepper" TEXT NOT NULL,

    CONSTRAINT "RateLimitConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SignupCode_codeHash_key" ON "SignupCode"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "SignupCode_organizationId_key" ON "SignupCode"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationDomain_organizationId_tenantId_idx" ON "OrganizationDomain"("organizationId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationDomain_organizationId_tenantId_id_key" ON "OrganizationDomain"("organizationId", "tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationDomain_organizationId_domain_key" ON "OrganizationDomain"("organizationId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_tenantId_subjectId_idx" ON "Invitation"("organizationId", "tenantId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_organizationId_tenantId_id_key" ON "Invitation"("organizationId", "tenantId", "id");

-- CreateIndex
CREATE INDEX "RateLimitBucket_windowStart_idx" ON "RateLimitBucket"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- AddForeignKey
ALTER TABLE "SignupCode" ADD CONSTRAINT "SignupCode_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationDomain" ADD CONSTRAINT "OrganizationDomain_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationDomain" ADD CONSTRAINT "OrganizationDomain_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_tenantId_fkey" FOREIGN KEY ("organizationId", "tenantId") REFERENCES "Tenant"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_tenantId_subjectId_fkey" FOREIGN KEY ("organizationId", "tenantId", "subjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_tenantId_invitedBySubjectId_fkey" FOREIGN KEY ("organizationId", "tenantId", "invitedBySubjectId") REFERENCES "Subject"("organizationId", "tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrity: secrets are stored as SHA-256 hex only, states are consistent.
-- ---------------------------------------------------------------------------
ALTER TABLE "SignupCode" ADD CONSTRAINT "SignupCode_hashes"
  CHECK ("codeHash" ~ '^[0-9a-f]{64}$' AND ("pendingChallengeHash" IS NULL OR "pendingChallengeHash" ~ '^[0-9a-f]{64}$'));
ALTER TABLE "SignupCode" ADD CONSTRAINT "SignupCode_state"
  CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '30 days'
    AND length("issuedBy") BETWEEN 1 AND 200
    AND (("status" = 'CONSUMED') = ("consumedAt" IS NOT NULL))
    AND (("status" = 'CONSUMED') = ("organizationId" IS NOT NULL))
    AND (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL))
    AND ("status" <> 'RESERVED' OR ("reservedAt" IS NOT NULL AND "pendingChallengeHash" IS NOT NULL
      AND "pendingExpiresAt" IS NOT NULL AND "pendingPayload" IS NOT NULL))
    AND ("status" = 'RESERVED' OR ("pendingChallengeHash" IS NULL AND "pendingExpiresAt" IS NULL AND "pendingPayload" IS NULL)));

ALTER TABLE "OrganizationDomain" ADD CONSTRAINT "OrganizationDomain_domain_format"
  CHECK ("domain" = lower("domain") AND length("domain") <= 253
    AND "domain" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$');
ALTER TABLE "OrganizationDomain" ADD CONSTRAINT "OrganizationDomain_state"
  CHECK ("challengeHash" ~ '^[0-9a-f]{64}$' AND ("status" <> 'VERIFIED' OR "verifiedAt" IS NOT NULL));
-- Requirement 11: a domain is VERIFIED by at most one organization, globally (not RLS-scoped).
CREATE UNIQUE INDEX "OrganizationDomain_verified_domain_key" ON "OrganizationDomain"(lower("domain")) WHERE "status" = 'VERIFIED';

ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_state"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'
    AND ("pendingChallengeHash" IS NULL OR "pendingChallengeHash" ~ '^[0-9a-f]{64}$')
    AND NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
    AND "expiresAt" = "createdAt" + interval '7 days');
-- One live invitation per person.
CREATE UNIQUE INDEX "Invitation_one_open_per_subject" ON "Invitation"("organizationId", "tenantId", "subjectId")
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;

ALTER TABLE "RateLimitBucket" ADD CONSTRAINT "RateLimitBucket_key" CHECK ("keyHash" ~ '^[0-9a-f]{64}$' AND "count" >= 0);
ALTER TABLE "RateLimitConfig" ADD CONSTRAINT "RateLimitConfig_single" CHECK ("id" = 1 AND "pepper" ~ '^[0-9a-f]{64}$');
INSERT INTO "RateLimitConfig" ("id", "pepper")
  VALUES (1, encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'));

-- ---------------------------------------------------------------------------
-- Forced RLS (requirement 13). Tenant tables get the standard tenant policy.
-- SignupCode, RateLimitBucket and RateLimitConfig get NO policy: app_user sees
-- and writes nothing there; only the SECURITY DEFINER functions below reach them.
-- ---------------------------------------------------------------------------
ALTER TABLE "OrganizationDomain" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationDomain" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invitation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SignupCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SignupCode" FORCE ROW LEVEL SECURITY;
ALTER TABLE "RateLimitBucket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RateLimitBucket" FORCE ROW LEVEL SECURITY;
ALTER TABLE "RateLimitConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RateLimitConfig" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_domain_scope ON "OrganizationDomain" USING ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true)) WITH CHECK ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true));
CREATE POLICY invitation_scope ON "Invitation" USING ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true)) WITH CHECK ("organizationId"=current_setting('app.organization_id',true) AND "tenantId"=current_setting('app.tenant_id',true));

-- ---------------------------------------------------------------------------
-- Guards (SECURITY INVOKER triggers, not executable by app_user).
-- ---------------------------------------------------------------------------
-- Requirement 4: the slug is immutable. A future change needs an explicit, reviewed
-- operator procedure (see docs/operations/CUSTOMER-SELF-ONBOARDING-V1-MIGRATION.md).
CREATE FUNCTION luxia_organization_slug_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."slug" IS DISTINCT FROM OLD."slug" THEN
    RAISE EXCEPTION 'ORGANIZATION_SLUG_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_organization_slug_guard() FROM PUBLIC;
CREATE TRIGGER organization_slug_immutable BEFORE UPDATE ON "Organization"
FOR EACH ROW EXECUTE FUNCTION luxia_organization_slug_guard();

-- Requirements 1 and 5: codes are never deleted, terminal states are final, a code is
-- consumed only before its expiry.
CREATE FUNCTION luxia_signup_code_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
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
REVOKE ALL ON FUNCTION luxia_signup_code_guard() FROM PUBLIC;
CREATE TRIGGER signup_code_guard BEFORE UPDATE OR DELETE ON "SignupCode"
FOR EACH ROW EXECUTE FUNCTION luxia_signup_code_guard();

-- Requirements 8 and 9: the database sets the 7-day expiry; tenant, person, role, token and
-- inviter never change; accepted or revoked invitations are final; no acceptance after expiry.
CREATE FUNCTION luxia_invitation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INVITATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."acceptedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL
       OR NEW."pendingChallengeHash" IS NOT NULL OR NEW."pendingExpiresAt" IS NOT NULL THEN
      RAISE EXCEPTION 'INVITATION_INVALID_INITIAL_STATE' USING ERRCODE = '23514';
    END IF;
    NEW."createdAt" := v_now;
    NEW."updatedAt" := v_now;
    NEW."expiresAt" := v_now + interval '7 days';
    RETURN NEW;
  END IF;
  IF OLD."acceptedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."subjectId" IS DISTINCT FROM OLD."subjectId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR NEW."role" IS DISTINCT FROM OLD."role"
     OR NEW."invitedBySubjectId" IS DISTINCT FROM OLD."invitedBySubjectId"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'INVITATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."acceptedAt" IS NOT NULL AND OLD."expiresAt" <= v_now THEN
    RAISE EXCEPTION 'INVITATION_EXPIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_invitation_guard() FROM PUBLIC;
CREATE TRIGGER invitation_guard BEFORE INSERT OR UPDATE OR DELETE ON "Invitation"
FOR EACH ROW EXECUTE FUNCTION luxia_invitation_guard();

-- Domains: the domain and its organization never change; rows are never deleted.
CREATE FUNCTION luxia_organization_domain_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ORGANIZATION_DOMAIN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."domain" IS DISTINCT FROM OLD."domain"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ORGANIZATION_DOMAIN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION luxia_organization_domain_guard() FROM PUBLIC;
CREATE TRIGGER organization_domain_guard BEFORE UPDATE OR DELETE ON "OrganizationDomain"
FOR EACH ROW EXECUTE FUNCTION luxia_organization_domain_guard();

-- ---------------------------------------------------------------------------
-- Narrow SECURITY DEFINER entry points (EXECUTE granted to app_user only).
-- They take hashes, never raw codes, tokens or client addresses.
-- ---------------------------------------------------------------------------
-- Requirement 3. Returns TRUE while the caller is within p_max hits for the current window.
-- The stored key is SHA-256(pepper:scope:clientHash); the pepper never leaves the database.
CREATE FUNCTION luxia_rate_limit_hit(p_scope TEXT, p_client_hash TEXT, p_window_seconds INTEGER, p_max INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_pepper TEXT;
  v_now TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC');
  v_window TIMESTAMP(3);
  v_count INTEGER;
BEGIN
  IF NOT coalesce(p_scope ~ '^[a-z][a-z0-9-]{1,39}$' AND p_client_hash ~ '^[0-9a-f]{64}$'
     AND p_window_seconds BETWEEN 1 AND 86400 AND p_max BETWEEN 1 AND 100000, false) THEN
    RAISE EXCEPTION 'RATE_LIMIT_INVALID_ARGUMENT' USING ERRCODE = '22023';
  END IF;
  SELECT c."pepper" INTO v_pepper FROM "RateLimitConfig" c WHERE c."id" = 1;
  IF v_pepper IS NULL THEN
    RAISE EXCEPTION 'RATE_LIMIT_NOT_CONFIGURED' USING ERRCODE = '55000';
  END IF;
  v_window := to_timestamp(floor(extract(epoch FROM v_now) / p_window_seconds) * p_window_seconds) AT TIME ZONE 'UTC';
  INSERT INTO "RateLimitBucket" AS b ("keyHash", "windowStart", "count")
  VALUES (encode(sha256(convert_to(v_pepper || ':' || p_scope || ':' || p_client_hash, 'UTF8')), 'hex'), v_window, 1)
  ON CONFLICT ("keyHash", "windowStart") DO UPDATE SET "count" = b."count" + 1
  RETURNING b."count" INTO v_count;
  IF random() < 0.02 THEN
    DELETE FROM "RateLimitBucket" WHERE "windowStart" < v_now - interval '2 days';
  END IF;
  RETURN v_count <= p_max;
END $$;
REVOKE ALL ON FUNCTION luxia_rate_limit_hit(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;

-- Signup begin: reserve a usable code for one WebAuthn ceremony. No organization is created.
-- The payload (organization name, slug, founder name, identifier) is validated here and is
-- the only source used at consumption, so the browser cannot change it in between.
CREATE FUNCTION luxia_signup_reserve(p_code_hash TEXT, p_challenge_hash TEXT, p_payload JSONB, p_ttl_seconds INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');
  v_rows INTEGER;
BEGIN
  IF NOT coalesce(p_code_hash ~ '^[0-9a-f]{64}$' AND p_challenge_hash ~ '^[0-9a-f]{64}$'
     AND p_ttl_seconds BETWEEN 60 AND 900 AND jsonb_typeof(p_payload) = 'object', false) THEN
    RETURN FALSE;
  END IF;
  IF NOT coalesce((SELECT count(*) FROM jsonb_object_keys(p_payload)) = 4
     AND jsonb_typeof(p_payload->'organizationName') = 'string' AND length(p_payload->>'organizationName') BETWEEN 2 AND 120
     AND jsonb_typeof(p_payload->'slug') = 'string' AND (p_payload->>'slug') ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
     AND position('--' in (p_payload->>'slug')) = 0
     AND jsonb_typeof(p_payload->'founderName') = 'string' AND length(p_payload->>'founderName') BETWEEN 2 AND 120
     AND jsonb_typeof(p_payload->'principalName') = 'string' AND length(p_payload->>'principalName') BETWEEN 3 AND 254, false) THEN
    RETURN FALSE;
  END IF;
  UPDATE "SignupCode" SET "status" = 'EXPIRED', "pendingChallengeHash" = NULL, "pendingExpiresAt" = NULL,
    "pendingPayload" = NULL, "updatedAt" = v_now
  WHERE "codeHash" = p_code_hash AND "status" IN ('ISSUED', 'RESERVED') AND "expiresAt" <= v_now;
  UPDATE "SignupCode" SET "status" = 'RESERVED', "reservedAt" = v_now, "pendingChallengeHash" = p_challenge_hash,
    "pendingExpiresAt" = v_now + make_interval(secs => p_ttl_seconds), "pendingPayload" = p_payload, "updatedAt" = v_now
  WHERE "codeHash" = p_code_hash AND "status" IN ('ISSUED', 'RESERVED') AND "expiresAt" > v_now;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;
REVOKE ALL ON FUNCTION luxia_signup_reserve(TEXT, TEXT, JSONB, INTEGER) FROM PUBLIC;

-- Signup complete: called INSIDE the founder transaction. Consumes the reserved code (exact
-- challenge, before expiry) and creates the Organization from the reserved payload. If any later
-- step of the transaction fails, the consumption and the organization roll back together.
CREATE FUNCTION luxia_signup_consume(p_code_hash TEXT, p_challenge_hash TEXT)
RETURNS TABLE(signup_code_id TEXT, organization_id TEXT, payload JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');
  v_code RECORD;
  v_org TEXT := gen_random_uuid()::text;
BEGIN
  IF NOT coalesce(p_code_hash ~ '^[0-9a-f]{64}$' AND p_challenge_hash ~ '^[0-9a-f]{64}$', false) THEN
    RETURN;
  END IF;
  SELECT s."id", s."status", s."expiresAt", s."pendingExpiresAt", s."pendingChallengeHash", s."pendingPayload"
    INTO v_code FROM "SignupCode" s WHERE s."codeHash" = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT coalesce(v_code."status" = 'RESERVED' AND v_code."expiresAt" > v_now AND v_code."pendingExpiresAt" > v_now
     AND v_code."pendingChallengeHash" = p_challenge_hash, false) THEN
    RETURN;
  END IF;
  INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
  VALUES (v_org, v_code."pendingPayload"->>'organizationName', v_code."pendingPayload"->>'slug', v_now, v_now);
  UPDATE "SignupCode" SET "status" = 'CONSUMED', "consumedAt" = v_now, "organizationId" = v_org,
    "pendingChallengeHash" = NULL, "pendingExpiresAt" = NULL, "pendingPayload" = NULL, "updatedAt" = v_now
  WHERE "id" = v_code."id";
  RETURN QUERY SELECT v_code."id"::TEXT, v_org, v_code."pendingPayload";
END $$;
REVOKE ALL ON FUNCTION luxia_signup_consume(TEXT, TEXT) FROM PUBLIC;

-- Invitation lookup for the unauthenticated invitee, by token hash only. Returns nothing for an
-- unknown, expired, accepted or revoked invitation. Everything else runs under tenant RLS.
CREATE FUNCTION luxia_invitation_resolve(p_token_hash TEXT)
RETURNS TABLE(invitation_id TEXT, organization_id TEXT, tenant_id TEXT, subject_id TEXT, invitation_role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i."id", i."organizationId", i."tenantId", i."subjectId", i."role"::TEXT
  FROM "Invitation" i
  WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND i."tokenHash" = p_token_hash
    AND i."acceptedAt" IS NULL AND i."revokedAt" IS NULL AND i."expiresAt" > (now() AT TIME ZONE 'UTC')
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION luxia_invitation_resolve(TEXT) FROM PUBLIC;

-- Requirement 2: anti-enumeration at sign-in. Returns a stable value that only the database can
-- compute (peppered), so a decoy answer for an unknown organization or identifier is the same on
-- every request and cannot be predicted or told apart from a real one.
CREATE FUNCTION luxia_login_decoy(p_input_hash TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_pepper TEXT;
BEGIN
  IF NOT coalesce(p_input_hash ~ '^[0-9a-f]{64}$', false) THEN
    RAISE EXCEPTION 'LOGIN_DECOY_INVALID_ARGUMENT' USING ERRCODE = '22023';
  END IF;
  SELECT c."pepper" INTO v_pepper FROM "RateLimitConfig" c WHERE c."id" = 1;
  IF v_pepper IS NULL THEN
    RAISE EXCEPTION 'RATE_LIMIT_NOT_CONFIGURED' USING ERRCODE = '55000';
  END IF;
  RETURN encode(sha256(convert_to(v_pepper || ':login-decoy:' || p_input_hash, 'UTF8')), 'hex');
END $$;
REVOKE ALL ON FUNCTION luxia_login_decoy(TEXT) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Runtime grants. In CI app_user is created after migrations (see ci.yml bootstrap).
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON FUNCTION luxia_organization_slug_guard() FROM app_user;
    REVOKE ALL ON FUNCTION luxia_signup_code_guard() FROM app_user;
    REVOKE ALL ON FUNCTION luxia_invitation_guard() FROM app_user;
    REVOKE ALL ON FUNCTION luxia_organization_domain_guard() FROM app_user;
    REVOKE ALL ON "SignupCode", "RateLimitBucket", "RateLimitConfig" FROM app_user;
    REVOKE ALL ON "OrganizationDomain", "Invitation" FROM app_user;
    GRANT SELECT, INSERT, UPDATE ON "OrganizationDomain", "Invitation" TO app_user;
    GRANT EXECUTE ON FUNCTION luxia_rate_limit_hit(TEXT, TEXT, INTEGER, INTEGER) TO app_user;
    GRANT EXECUTE ON FUNCTION luxia_signup_reserve(TEXT, TEXT, JSONB, INTEGER) TO app_user;
    GRANT EXECUTE ON FUNCTION luxia_signup_consume(TEXT, TEXT) TO app_user;
    GRANT EXECUTE ON FUNCTION luxia_invitation_resolve(TEXT) TO app_user;
    GRANT EXECUTE ON FUNCTION luxia_login_decoy(TEXT) TO app_user;
  END IF;
END $$;
