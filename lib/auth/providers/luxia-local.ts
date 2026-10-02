import { randomUUID } from "node:crypto";
import { EnvironmentSecretResolver } from "@/lib/provider-adapters/infrastructure/environment-secret-resolver";
import { LuxiaLocalAdapter } from "@/lib/provider-adapters/implementations/luxia-local/luxia-local-adapter";
import { PrismaLocalIdentityStore } from "@/lib/provider-adapters/implementations/luxia-local/prisma-local-identity-store";
import type { ProviderOperationContext } from "@/lib/provider-adapters";

const adapter = new LuxiaLocalAdapter(
  new PrismaLocalIdentityStore(),
  new EnvironmentSecretResolver(),
);

export function localProviderContext(input: {
  organizationId: string;
  tenantId: string;
  providerConnectionId: string;
}): ProviderOperationContext {
  return { ...input, operationId: randomUUID() };
}

export function getLuxiaLocalAdapter(): LuxiaLocalAdapter {
  return adapter;
}
