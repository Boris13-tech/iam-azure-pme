import type {
  ProviderOperationContext,
  SecretReference,
} from "../..";

export const MICROSOFT_ENTRA_PROVIDER_TYPE = "MICROSOFT_ENTRA" as const;

export type MicrosoftEntraConnectionConfig = Readonly<{
  organizationId: string;
  tenantId: string;
  providerConnectionId: string;
  directoryTenantId: string;
  redirectUri: string;
  oidcClientId?: string;
  oidcClientSecret?: SecretReference;
  graphTenantId?: string;
  graphClientId?: string;
  graphClientSecret?: SecretReference;
}>;

export interface MicrosoftEntraConnectionConfigResolver {
  resolve(
    context: ProviderOperationContext,
  ): Promise<MicrosoftEntraConnectionConfig>;
}

export type MicrosoftEntraGraphUser = Readonly<{
  id: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  accountEnabled?: boolean;
  raw?: Readonly<Record<string, unknown>>;
}>;

export type MicrosoftEntraCreatedUser = Readonly<{
  id: string;
  userPrincipalName: string;
}>;

export type MicrosoftEntraAuthorizationResult = Readonly<{
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: string;
}>;

export type MicrosoftEntraVerifiedClaims = Readonly<{
  oid: string;
  tid: string;
  iss: string;
  email?: string;
  preferredUsername?: string;
  name?: string;
}>;
