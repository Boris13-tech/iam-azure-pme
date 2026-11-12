-- Rollback of 20261112100000_retention_status. Run as the owner, in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f <this file>
-- Removes the status function. Always possible. The run records it wrote stay in RetentionRun (counts only), and are
-- purged by R3 after 400 days like every run record.
SET lock_timeout = '5s';
DROP FUNCTION IF EXISTS luxia_retention_status();
