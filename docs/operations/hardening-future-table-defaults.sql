-- Operator-authorized separate hardening. Only FUTURE tables are affected.
-- Existing table ACLs and identity data must compare unchanged.
-- These grants were found specifically in the creator's public-schema defaults;
-- unlike the global function revocation, this removes that schema-specific entry.
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_user;
-- Each candidate migration explicitly revokes inherited privileges on its NEW
-- tables, then grants only required runtime privileges. No legacy table changes.
