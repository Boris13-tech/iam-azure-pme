-- Separate hardening change: NOT part of Resources / SoD / Access Reviews.
-- Production execution requires separate explicit approval.
-- Preconditions: migration connection's current_user = session_user and this
-- role is the actual creator of future migration functions. On the certified
-- clone both are neondb_owner. Do not use SET ROLE to conceal a mismatch.
-- Global revocation: deliberately no IN SCHEMA clause.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- Existing function ACLs (including resolve_session) are not changed.
-- Explicit runtime grants remain the responsibility of each migration.
