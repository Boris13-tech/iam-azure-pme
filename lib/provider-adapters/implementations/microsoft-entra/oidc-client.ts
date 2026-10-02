import * as client from "openid-client";
import {
  ProviderAdapterError,
  type ProviderOperationContext,
  type SecretResolver,
} from "../..";
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

export class OpenIdClientMicrosoftEntraGateway
  implements MicrosoftEntraOidcGateway
{
  constructor(private readonly secrets: SecretResolver) {}

  async begin(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
  ): Promise<MicrosoftEntraAuthorizationResult> {
    return this.withConfig(context, config, async (oidcConfig) => {
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();
      const authorizationUrl = client.buildAuthorizationUrl(oidcConfig, {
        redirect_uri: config.redirectUri,
        scope: "openid profile email",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        nonce,
      });
      return {
        authorizationUrl: authorizationUrl.href,
        state,
        nonce,
        codeVerifier,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    });
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
    return this.withConfig(context, config, async (oidcConfig) => {
      const tokens = await client.authorizationCodeGrant(
        oidcConfig,
        new URL(input.currentUrl),
        {
          pkceCodeVerifier: input.codeVerifier,
          expectedState: input.expectedState,
          expectedNonce: input.expectedNonce,
          idTokenExpected: true,
        },
      );
      const claims = tokens.claims();
      if (!claims) {
        throw new ProviderAdapterError({
          code: "AUTHENTICATION_FAILED",
          message: "No claims in Microsoft Entra token",
          safeDetails: { reason: "NO_CLAIMS" },
        });
      }
      const oid = typeof claims.oid === "string" ? claims.oid : "";
      const tid = typeof claims.tid === "string" ? claims.tid : "";
      const iss = typeof claims.iss === "string" ? claims.iss : "";
      if (!oid) {
        throw new ProviderAdapterError({
          code: "AUTHENTICATION_FAILED",
          message: "Missing oid in Microsoft Entra token",
          safeDetails: { reason: "MISSING_OID" },
        });
      }
      return {
        oid,
        tid,
        iss,
        email: stringClaim(claims.email),
        preferredUsername: stringClaim(claims.preferred_username),
        name: stringClaim(claims.name),
      };
    });
  }

  async logoutUrl(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    postLogoutRedirectUri: string,
  ): Promise<string | null> {
    return this.withConfig(context, config, async (oidcConfig) => {
      const endpoint = oidcConfig.serverMetadata().end_session_endpoint;
      if (!endpoint) return null;
      const url = new URL(endpoint);
      url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
      return url.href;
    });
  }

  private async withConfig<T>(
    context: ProviderOperationContext,
    config: MicrosoftEntraConnectionConfig,
    action: (oidcConfig: client.Configuration) => Promise<T>,
  ): Promise<T> {
    if (!config.oidcClientId || !config.oidcClientSecret) {
      throw new ProviderAdapterError({
        code: "MISCONFIGURED",
        message: "Missing Microsoft Entra OIDC configuration",
        safeDetails: { providerConnectionId: context.providerConnectionId },
      });
    }
    try {
      return await this.secrets.withSecret(
        context,
        config.oidcClientSecret,
        (lease) =>
          lease.use(async (secretBytes) => {
            const secret = new TextDecoder().decode(secretBytes);
            const issuer = new URL(
              `https://login.microsoftonline.com/${config.directoryTenantId}/v2.0`,
            );
            const oidcConfig = await client.discovery(
              issuer,
              config.oidcClientId!,
              secret,
            );
            return action(oidcConfig);
          }),
      );
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      throw new ProviderAdapterError({
        code: "AUTHENTICATION_FAILED",
        message: "Microsoft Entra OIDC operation failed",
      });
    }
  }
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
