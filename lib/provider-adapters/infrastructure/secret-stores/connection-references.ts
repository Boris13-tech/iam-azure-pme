import type { ProviderSecretPurpose } from "@prisma/client";
import { withTenantDb } from "../../../db/scoped-client";
import { assertProviderOperationContext, type ProviderOperationContext, type SecretReference } from "../..";

// F3: the secret reference of one connection and purpose, read inside the organization's scope (forced RLS). Only the
// live (not revoked) reference counts, with its pinned version: `active` for sign-ins, `candidate` for a connection test
// before a promotion. No reference means no secret: callers fail closed; there is never a global fallback.
export async function connectionSecretReference(
  context: ProviderOperationContext,
  purpose: ProviderSecretPurpose,
  which: "active" | "candidate" = "active",
): Promise<SecretReference | null> {
  assertProviderOperationContext(context);
  const row = await withTenantDb({ organizationId: context.organizationId, tenantId: context.tenantId }, (tx) =>
    tx.providerSecretReference.findFirst({
      where: { organizationId: context.organizationId, providerConnectionId: context.providerConnectionId, purpose, revokedAt: null },
      select: { locator: true, activeVersion: true, candidateVersion: true },
    }));
  if (!row) return null;
  const version = which === "active" ? row.activeVersion : row.candidateVersion;
  return version ? Object.freeze({ key: row.locator, version }) : null;
}
