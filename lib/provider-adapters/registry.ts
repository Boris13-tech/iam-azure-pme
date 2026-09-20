import type { ProviderCapability } from "./capabilities";
import { ProviderRegistryError } from "./errors";
import {
  requireProviderCapability,
  type ProviderAdapter,
} from "./provider-adapter";
import {
  PROVIDER_ADAPTER_CONTRACT_VERSION,
  type ProviderTypeId,
} from "./types";

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<ProviderTypeId, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (!adapter.type.trim()) {
      throw new ProviderRegistryError(
        "CONFLICT",
        "Provider adapter type must not be empty",
      );
    }

    if (adapter.contractVersion !== PROVIDER_ADAPTER_CONTRACT_VERSION) {
      throw new ProviderRegistryError(
        "CONFLICT",
        `Unsupported provider adapter contract version '${adapter.contractVersion}'`,
      );
    }

    if (this.adapters.has(adapter.type)) {
      throw new ProviderRegistryError(
        "CONFLICT",
        `Provider adapter '${adapter.type}' is already registered`,
      );
    }

    this.adapters.set(adapter.type, adapter);
  }

  resolve(type: ProviderTypeId): ProviderAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new ProviderRegistryError(
        "NOT_FOUND",
        `Provider adapter '${type}' is not registered`,
      );
    }
    return adapter;
  }

  resolveWithCapability(
    type: ProviderTypeId,
    capability: ProviderCapability,
  ): ProviderAdapter {
    const adapter = this.resolve(type);
    requireProviderCapability(adapter, capability);
    return adapter;
  }

  list(): ReadonlyArray<
    Readonly<{
      type: ProviderTypeId;
      contractVersion: number;
      capabilities: ReadonlyArray<ProviderCapability>;
    }>
  > {
    return Array.from(this.adapters.values(), (adapter) => ({
      type: adapter.type,
      contractVersion: adapter.contractVersion,
      capabilities: Array.from(adapter.capabilities()).sort(),
    })).sort((left, right) => left.type.localeCompare(right.type));
  }
}
