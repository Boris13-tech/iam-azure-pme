-- F4, slice S4 (docs/architecture/F4-GENERIC-OIDC-CONNECTIONS-DESIGN.md, section 4): a federated round trip is bound to
-- the configuration it started with. Expand only: one nullable column, written and read by generic OIDC sign-in only.
-- Microsoft transactions leave it NULL; the application deployed before this migration neither reads nor writes it.
-- The callback refuses a generic transaction whose recorded hash is missing or differs from the connection's current
-- configurationHash (computed by the database, slice S2).
-- Prisma applies this file as one transaction. Rollback: docs/operations/AUTH-TRANSACTION-CONFIGURATION-BINDING-ROLLBACK.sql

SET lock_timeout = '5s';

ALTER TABLE "AuthTransaction" ADD COLUMN "expectedConfigurationHash" TEXT;
ALTER TABLE "AuthTransaction" ADD CONSTRAINT "AuthTransaction_expectedConfigurationHash" CHECK (
  "expectedConfigurationHash" IS NULL OR "expectedConfigurationHash" ~ '^[0-9a-f]{64}$');

RESET lock_timeout;
