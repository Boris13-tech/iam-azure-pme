-- Only the new integration's evidence is made append-only. No business seeds,
-- grants, identity changes, changes to legacy tables or previous audit rows.
CREATE FUNCTION luxia_resource_onboarding_evidence_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
REVOKE ALL ON FUNCTION luxia_resource_onboarding_evidence_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON FUNCTION luxia_resource_onboarding_evidence_guard() FROM app_user;
  END IF;
END $$;
CREATE TRIGGER resource_onboarding_evidence_immutable
BEFORE UPDATE OR DELETE ON "CanonicalAdminAuditEvent"
FOR EACH ROW EXECUTE FUNCTION luxia_resource_onboarding_evidence_guard();
