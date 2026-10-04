import { z } from "zod";
import { createHash } from "node:crypto";

export function connectionSecretReference(scope: { organizationId: string; tenantId: string; providerConnectionId: string }) {
  return `LUXIA_PROVIDER_${createHash("sha256").update(JSON.stringify([
    scope.organizationId, scope.tenantId, scope.providerConnectionId,
  ])).digest("hex").toUpperCase()}`;
}

export function versionedConnectionSecretReference(scope: {
  organizationId: string; tenantId: string; providerConnectionId: string; providerType: string; credentialVersion: string;
}) {
  return `LUXIA_PROVIDER_VERSION_${createHash('sha256').update(JSON.stringify([
    scope.organizationId,scope.tenantId,scope.providerConnectionId,scope.providerType,scope.credentialVersion,
  ])).digest('hex').toUpperCase()}`;
}

export const managedProviderTypes = ["MICROSOFT_ENTRA", "GOOGLE_WORKSPACE", "OIDC_GENERIC"] as const;
export const preparedProviderTypes = ["LDAP", "ACTIVE_DIRECTORY", "SAMBA_AD", "GITHUB", "AWS", "SAML", "SCIM"] as const;

// Provider identifiers never participate in canonical identity ownership.
export const attributeMappingSchema = z.object({
  displayName: z.enum(["displayName", "name.fullName"]).optional(),
  principalName: z.enum(["userPrincipalName", "primaryEmail"]).optional(),
}).strict();
export type AttributeMapping = z.infer<typeof attributeMappingSchema>;

export const configurationSchema = z.object({
  clientId: z.string().uuid().optional(),
  issuer: z.string().url().max(512).refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, "Issuer must be a public HTTPS URL without credentials, query or fragment").optional(),
  customerId: z.string().trim().min(1).max(200).optional(),
}).strict();

export const providerManagementUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  configuration: configurationSchema.optional(),
  credentialSecretRef: z.string().regex(/^LUXIA_PROVIDER_[A-Z0-9_]{1,100}$/).nullable().optional(),
  attributeMapping: attributeMappingSchema.optional(),
  expectedMappingVersion: z.number().int().positive(),
}).strict();

export type ProviderManagementUpdate = z.infer<typeof providerManagementUpdateSchema>;
export type ProviderOperation = "CONNECTION_TEST" | "SYNC_DRY_RUN";
export type DiscoveryProjection = Readonly<{
  externalObjectId: string;
  displayName: string;
  principalName?: string;
}>;
export interface ProviderManagementDriver {
  testConnection(): Promise<void>;
  discover(): AsyncIterable<DiscoveryProjection>;
}

export class ProviderManagementFailure extends Error {
  constructor(public readonly safeCode: string) { super(safeCode); }
}

export function applyAttributeMapping(
  raw: Record<string, unknown>, mapping: AttributeMapping,
): DiscoveryProjection {
  // Stable ID is mandatory and cannot be remapped to email/name.
  if (typeof raw.id !== "string" || !raw.id.trim() || raw.id.length > 512) {
    throw new ProviderManagementFailure("INVALID_EXTERNAL_ID");
  }
  function field(path: string): string | undefined {
    let value: unknown = raw;
    for (const part of path.split(".")) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    if (typeof value !== "string") return undefined;
    if (value.length > 512 || /[\u0000-\u001f]/.test(value)) {
      throw new ProviderManagementFailure("INVALID_PROVIDER_RESPONSE");
    }
    return value;
  }
  return {
    externalObjectId: raw.id,
    displayName: field(mapping.displayName ?? "displayName") ?? raw.id,
    principalName: mapping.principalName ? field(mapping.principalName) : undefined,
  };
}

export function reconcileDryRun(
  projections: readonly DiscoveryProjection[],
  linkedIds: ReadonlySet<string>,
) {
  const seen = new Set<string>();
  const collisions = new Set<string>();
  for (const projection of projections) {
    if (seen.has(projection.externalObjectId)) collisions.add(projection.externalObjectId);
    seen.add(projection.externalObjectId);
  }
  return {
    observed: projections.length,
    linked: [...seen].filter(id => linkedIds.has(id) && !collisions.has(id)).length,
    unlinked: [...seen].filter(id => !linkedIds.has(id) && !collisions.has(id)).length,
    collisions: [...collisions].sort(),
    created: 0, updated: 0, disabled: 0,
  };
}
