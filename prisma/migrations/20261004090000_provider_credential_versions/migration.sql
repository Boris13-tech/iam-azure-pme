-- Metadata only; existing tenant-scope ENABLE/FORCE RLS and FKs remain intact.
ALTER TABLE "ProviderConnectionTenantScope"
  ADD COLUMN "activeCredentialVersion" TEXT,
  ADD COLUMN "candidateCredentialVersion" TEXT,
  ADD COLUMN "credentialRevoked" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "ProviderCredentialVersionFormat" CHECK (
    ("activeCredentialVersion" IS NULL OR "activeCredentialVersion" ~ '^[A-Za-z0-9._-]{1,64}$') AND
    ("candidateCredentialVersion" IS NULL OR "candidateCredentialVersion" ~ '^[A-Za-z0-9._-]{1,64}$') AND
    ("candidateCredentialVersion" IS NULL OR
      ("activeCredentialVersion" IS NOT NULL AND "candidateCredentialVersion" <> "activeCredentialVersion"))
  );
-- No invented active version or secret-reference backfill for existing providers.
