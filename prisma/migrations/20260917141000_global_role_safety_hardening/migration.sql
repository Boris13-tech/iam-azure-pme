-- Function to freeze global role definitions for the application runtime role
CREATE OR REPLACE FUNCTION prevent_global_role_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF current_user = 'app_user' THEN
        RAISE EXCEPTION 'Global role definitions are frozen during Phase 5E/5F for app_user';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers to Role, Permission, and RolePermission tables
DROP TRIGGER IF EXISTS freeze_role_mutation ON "Role";
CREATE TRIGGER freeze_role_mutation
BEFORE INSERT OR UPDATE OR DELETE ON "Role"
FOR EACH ROW EXECUTE FUNCTION prevent_global_role_mutation();

DROP TRIGGER IF EXISTS freeze_permission_mutation ON "Permission";
CREATE TRIGGER freeze_permission_mutation
BEFORE INSERT OR UPDATE OR DELETE ON "Permission"
FOR EACH ROW EXECUTE FUNCTION prevent_global_role_mutation();

DROP TRIGGER IF EXISTS freeze_role_permission_mutation ON "RolePermission";
CREATE TRIGGER freeze_role_permission_mutation
BEFORE UPDATE OR DELETE OR INSERT ON "RolePermission"
FOR EACH ROW EXECUTE FUNCTION prevent_global_role_mutation();

-- Note: UserRole (membership) deliberately has NO trigger, to allow dual-write
