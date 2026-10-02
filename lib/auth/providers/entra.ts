import { randomUUID } from "node:crypto";
import type { ProviderConnection } from "@prisma/client";
import type {
  AuthChallenge,
  ProviderOperationContext,
  VerifiedExternalIdentity,
} from "../../provider-adapters";
import { getMicrosoftEntraAdapter } from "../../provider-adapters/implementations/microsoft-entra/runtime";

type EntraProviderConnection = Pick<
  ProviderConnection,
  "id" | "organizationId" | "providerType"
>;

export async function beginEntraAuthentication(input: {
  providerConnection: EntraProviderConnection;
  tenantId: string;
  returnTo?: string;
}): Promise<AuthChallenge> {
  assertEntra(input.providerConnection);
  return getMicrosoftEntraAdapter().beginAuthentication({
    context: context(
      input.providerConnection,
      input.tenantId,
      `oidc-login:${randomUUID()}`,
    ),
    returnTo: input.returnTo,
  });
}

export async function completeEntraAuthentication(input: {
  providerConnection: EntraProviderConnection;
  tenantId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  currentUrl: string;
}): Promise<VerifiedExternalIdentity> {
  assertEntra(input.providerConnection);
  return getMicrosoftEntraAdapter().completeAuthentication({
    context: context(
      input.providerConnection,
      input.tenantId,
      `oidc-callback:${input.state}`,
    ),
    transactionId: input.state,
    response: {
      currentUrl: input.currentUrl,
      expectedState: input.state,
      expectedNonce: input.nonce,
      codeVerifier: input.codeVerifier,
    },
  });
}

export async function getEntraLogoutUrl(input: {
  providerConnection: EntraProviderConnection;
  tenantId: string;
  postLogoutRedirectUri: string;
}): Promise<string | null> {
  assertEntra(input.providerConnection);
  const result = await getMicrosoftEntraAdapter().beginLogout({
    context: context(
      input.providerConnection,
      input.tenantId,
      `oidc-logout:${randomUUID()}`,
    ),
    identity: { externalObjectId: "session-bound" },
    postLogoutRedirectUri: input.postLogoutRedirectUri,
  });
  return result?.redirectUrl ?? null;
}

function context(
  provider: EntraProviderConnection,
  tenantId: string,
  operationId: string,
): ProviderOperationContext {
  return {
    organizationId: provider.organizationId,
    tenantId,
    providerConnectionId: provider.id,
    operationId,
  };
}

function assertEntra(provider: EntraProviderConnection): void {
  if (provider.providerType !== "MICROSOFT_ENTRA") {
    throw new Error("Unsupported provider type");
  }
}
