import { randomUUID } from "node:crypto";
import type { ProviderConnection } from "@prisma/client";
import type { AuthChallenge, ProviderOperationContext, VerifiedExternalIdentity } from "../../provider-adapters";
import { getGenericOidcAuthenticationProvider } from "../../provider-adapters/implementations/oidc-generic/runtime";

// F4, slice S4: the application's entry to generic OIDC sign-in, the counterpart of ./entra.ts for OIDC_GENERIC.
type GenericProviderConnection = Pick<ProviderConnection, "id" | "organizationId" | "providerType">;

export async function beginGenericOidcAuthentication(input: {
  providerConnection: GenericProviderConnection;
  tenantId: string;
  returnTo?: string;
}): Promise<AuthChallenge> {
  assertGeneric(input.providerConnection);
  return getGenericOidcAuthenticationProvider().beginAuthentication({
    context: context(input.providerConnection, input.tenantId, `oidc-login:${randomUUID()}`),
    returnTo: input.returnTo,
  });
}

export async function completeGenericOidcAuthentication(input: {
  providerConnection: GenericProviderConnection;
  tenantId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  expectedConfigurationHash: string;
  currentUrl: string;
}): Promise<VerifiedExternalIdentity> {
  assertGeneric(input.providerConnection);
  return getGenericOidcAuthenticationProvider().completeAuthentication({
    context: context(input.providerConnection, input.tenantId, `oidc-callback:${input.state}`),
    transactionId: input.state,
    response: {
      currentUrl: input.currentUrl,
      expectedState: input.state,
      expectedNonce: input.nonce,
      codeVerifier: input.codeVerifier,
      expectedConfigurationHash: input.expectedConfigurationHash,
    },
  });
}

function context(provider: GenericProviderConnection, tenantId: string, operationId: string): ProviderOperationContext {
  return { organizationId: provider.organizationId, tenantId, providerConnectionId: provider.id, operationId };
}

function assertGeneric(provider: GenericProviderConnection): void {
  if (provider.providerType !== "OIDC_GENERIC") throw new Error("Unsupported provider type");
}
