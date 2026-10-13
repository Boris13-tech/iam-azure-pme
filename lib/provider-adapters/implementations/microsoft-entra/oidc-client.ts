import {
  ProviderAdapterError,
  type ProviderOperationContext,
  type SecretResolver,
} from "../..";
import { OpenIdClientOidcGateway, type OidcClientConfig, type OidcProfile, type OidcVerifiedClaims } from "../oidc";
import type {
  MicrosoftEntraAuthorizationResult,
  MicrosoftEntraConnectionConfig,
  MicrosoftEntraVerifiedClaims,
} from "./types";

export interface MicrosoftEntraOidcGateway {
  begin(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
  ): Promise<MicrosoftEntraAuthorizationResult>;
  complete(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    input: {
      currentUrl: string;
      codeVerifier: string;
      expectedState: string;
      expectedNonce: string;
    },
  ): Promise<MicrosoftEntraVerifiedClaims>;
  logoutUrl(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    postLogoutRedirectUri: string,
  ): Promise<string | null>;
}

/** Microsoft Entra as a profile of the generic OIDC core: a per-directory issuer and `oid` as the stable subject. */
export const MICROSOFT_ENTRA_OIDC_PROFILE: OidcProfile = { displayName: "Microsoft Entra", subjectClaim: "oid" };

/** The tenant-specific v2.0 issuer. The `common` and `organizations` endpoints are never used. */
export function microsoftEntraIssuer(directoryTenantId: string): string {
  return `https://login.microsoftonline.com/${directoryTenantId}/v2.0`;
}

export function microsoftEntraClaims(verified: OidcVerifiedClaims): MicrosoftEntraVerifiedClaims {
  const claims = verified.claims;
  return {
    oid: verified.subject,
    tid: typeof claims.tid === "string" ? claims.tid : "",
    iss: verified.issuer,
    email: stringClaim(claims.email),
    preferredUsername: stringClaim(claims.preferred_username),
    name: stringClaim(claims.name),
  };
}

export class OpenIdClientMicrosoftEntraGateway implements MicrosoftEntraOidcGateway {
  private readonly oidc: OpenIdClientOidcGateway;

  constructor(secrets: SecretResolver) {
    this.oidc = new OpenIdClientOidcGateway(secrets);
  }

  async begin(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
  ): Promise<MicrosoftEntraAuthorizationResult> {
    return this.oidc.begin(context, MICROSOFT_ENTRA_OIDC_PROFILE, clientConfig(context, config));
  }

  async complete(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    input: {
      currentUrl: string;
      codeVerifier: string;
      expectedState: string;
      expectedNonce: string;
    },
  ): Promise<MicrosoftEntraVerifiedClaims> {
    return microsoftEntraClaims(await this.oidc.complete(context, MICROSOFT_ENTRA_OIDC_PROFILE, clientConfig(context, config), input));
  }

  async logoutUrl(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    postLogoutRedirectUri: string,
  ): Promise<string | null> {
    return this.oidc.logoutUrl(context, MICROSOFT_ENTRA_OIDC_PROFILE, clientConfig(context, config), postLogoutRedirectUri);
  }
}

function clientConfig(context: ProviderOperationContext, config: MicrosoftEntraConnectionConfig): OidcClientConfig {
  if (!config.oidcClientId || !config.oidcClientSecret) {
    throw new ProviderAdapterError({
      code: "MISCONFIGURED",
      message: "Missing Microsoft Entra OIDC configuration",
      safeDetails: { providerConnectionId: context.providerConnectionId },
    });
  }
  return {
    issuer: microsoftEntraIssuer(config.directoryTenantId),
    clientId: config.oidcClientId,
    clientSecret: config.oidcClientSecret,
    redirectUri: config.redirectUri,
  };
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
