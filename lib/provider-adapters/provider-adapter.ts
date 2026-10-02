import type { ProviderCapability } from "./capabilities";
import { UnsupportedProviderCapabilityError } from "./errors";
import type {
  CreateIdentityCommand,
  DiscoveredIdentity,
  ExternalIdentityRef,
  GrantAccessCommand,
  ProviderGroup,
  ProviderHealth,
  ProviderOperationContext,
  ProviderResource,
  ProviderTypeId,
  ProvisionResult,
  RevokeAccessCommand,
  SyncCursor,
  SyncRequest,
  SyncResult,
} from "./types";
import type { ProviderAdapterContractVersion } from "./types";

export interface ProviderAdapter {
  readonly type: ProviderTypeId;
  readonly contractVersion: ProviderAdapterContractVersion;

  capabilities(): ReadonlySet<ProviderCapability>;
  discoverUsers(
    context: ProviderOperationContext,
    cursor?: SyncCursor,
  ): AsyncIterable<DiscoveredIdentity>;
  getUser(
    context: ProviderOperationContext,
    ref: ExternalIdentityRef,
  ): Promise<DiscoveredIdentity["identity"] | null>;
  createIdentity(
    context: ProviderOperationContext,
    command: CreateIdentityCommand,
  ): Promise<ProvisionResult>;
  disableIdentity(
    context: ProviderOperationContext,
    ref: ExternalIdentityRef,
  ): Promise<ProvisionResult>;
  listGroups(
    context: ProviderOperationContext,
    cursor?: SyncCursor,
  ): AsyncIterable<ProviderGroup>;
  listResources(
    context: ProviderOperationContext,
    cursor?: SyncCursor,
  ): AsyncIterable<ProviderResource>;
  grantAccess(
    context: ProviderOperationContext,
    command: GrantAccessCommand,
  ): Promise<ProvisionResult>;
  revokeAccess(
    context: ProviderOperationContext,
    command: RevokeAccessCommand,
  ): Promise<ProvisionResult>;
  sync(
    context: ProviderOperationContext,
    request: SyncRequest,
  ): Promise<SyncResult>;
  healthCheck(context: ProviderOperationContext): Promise<ProviderHealth>;
}

export function supportsCapability(
  adapter: ProviderAdapter,
  capability: ProviderCapability,
): boolean {
  return adapter.capabilities().has(capability);
}

export function requireProviderCapability(
  adapter: ProviderAdapter,
  capability: ProviderCapability,
): void {
  if (!supportsCapability(adapter, capability)) {
    throw new UnsupportedProviderCapabilityError(adapter.type, capability);
  }
}
