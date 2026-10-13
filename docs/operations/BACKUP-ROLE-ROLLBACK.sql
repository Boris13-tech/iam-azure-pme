-- Rollback of the independent backup role (scripts/backup/luxia-backup-role.sql). Run as the schema owner.
-- Effect: the backup workflow stops working (it fails loudly). No application data is touched: luxia_backup owns
-- nothing; DROP OWNED BY only removes the privileges and default privileges granted to it.
-- Afterwards, delete the GitHub environment secret LUXIA_BACKUP_DATABASE_URL (environment production-backup).
BEGIN;
DROP OWNED BY luxia_backup;
DROP ROLE luxia_backup;
COMMIT;
