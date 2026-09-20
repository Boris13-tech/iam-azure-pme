import { ProviderAdapterError } from "./errors";

export const PROVIDER_ADAPTER_CONTRACT_VERSION = 1 as const;

export type ProviderAdapterContractVersion =
  typeof PROVIDER_ADAPTER_CONTRACT_VERSION;

/**
 * Stable adapter discriminator. It deliberately does not import Prisma's
 * ProviderType so the contract can be used by every LUXIA runtime.
 */
export type ProviderTypeId = string;

export type ProviderOperationContext = Readonly<{
  organizationId: string;
  tenantId: string;
  providerConnectionId: string;
  operationId: string;
}>;

export type ExternalIdentityRef = Readonly<{
  externalObjectId: string;
}>;

export type ExternalGroupRef = Readonly<{
  externalGroupId: string;
}>;

export type ExternalResourceRef = Readonly<{
  externalResourceId: string;
}>;

export type ProviderAttributeValue = string | number | boolean | null;
export type ProviderAttributes = Readonly<Record<string, ProviderAttributeValue>>;

export type ProviderIdentityStatus =
  | "ACTIVE"
  | "DISABLED"
  | "PENDING"
  | "UNKNOWN";

export type ProviderIdentity = Readonly<{
  ref: ExternalIdentityRef;
  displayName: string;
  principalName?: string;
  status: ProviderIdentityStatus;
  attributes: ProviderAttributes;
  observedAt: string;
  version?: string;
}>;

export type DiscoveredIdentity = Readonly<{
  identity: ProviderIdentity;
  cursor?: SyncCursor;
}>;

export type ProviderGroup = Readonly<{
  ref: ExternalGroupRef;
  displayName: string;
  attributes: ProviderAttributes;
  observedAt: string;
  version?: string;
}>;

export type ProviderResource = Readonly<{
  ref: ExternalResourceRef;
  displayName: string;
  resourceType: string;
  attributes: ProviderAttributes;
  observedAt: string;
  version?: string;
}>;

export type SyncCursor = Readonly<{
  value: string;
  version: number;
}>;

export type CreateIdentityCommand = Readonly<{
  subjectId: string;
  displayName: string;
  principalName?: string;
  attributes?: ProviderAttributes;
}>;

export type GrantAccessCommand = Readonly<{
  identity: ExternalIdentityRef;
  resource: ExternalResourceRef;
  entitlementKey: string;
}>;

export type RevokeAccessCommand = GrantAccessCommand;

export type SyncRequest = Readonly<{
  cursor?: SyncCursor;
  mode: "INCREMENTAL" | "FULL";
  maximumItems?: number;
}>;

export type ProviderMutationStatus =
  | "ACCEPTED"
  | "APPLIED"
  | "RETRYABLE_FAILURE"
  | "PERMANENT_FAILURE"
  | "CONFLICT";

export type ProvisionResult = Readonly<{
  operationId: string;
  status: ProviderMutationStatus;
  identity?: ExternalIdentityRef;
  providerVersion?: string;
  retryAfterMs?: number;
  safeMessage?: string;
}>;

export type SyncResult = Readonly<{
  operationId: string;
  status: ProviderMutationStatus;
  nextCursor?: SyncCursor;
  observed: number;
  created: number;
  updated: number;
  disabled: number;
  conflicts: number;
}>;

export type ProviderHealthStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "MISCONFIGURED";

export type ProviderHealth = Readonly<{
  status: ProviderHealthStatus;
  checkedAt: string;
  latencyMs?: number;
  safeMessage?: string;
}>;

export function assertProviderOperationContext(
  context: ProviderOperationContext,
): void {
  const required: ReadonlyArray<keyof ProviderOperationContext> = [
    "organizationId",
    "tenantId",
    "providerConnectionId",
    "operationId",
  ];

  for (const field of required) {
    if (!context[field]?.trim()) {
      throw new ProviderAdapterError({
        code: "INVALID_SCOPE",
        message: `Invalid provider operation scope: ${field} is required`,
        safeDetails: { field },
      });
    }
  }
}
