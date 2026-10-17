import * as client from "openid-client";
import {
  ProviderAdapterError,
  type ProviderOperationContext,
  type SecretResolver,
} from "../..";
import type {
  OidcAuthorizationResult,
  OidcCallback,
  OidcClientConfig,
  OidcProfile,
  OidcVerifiedClaims,
} from "./types";
import { OutboundRefusedError, createGuardedFetch } from "../../infrastructure/outbound/guarded-fetch";

/**
 * The generic OpenID Connect gateway: authorization code with PKCE (S256), single-use state and nonce, discovery of
 * the exact issuer, and an ID token verified by openid-client (signature against the issuer's JWKS, issuer, audience,
 * expiry, nonce). On top of that it pins the signature algorithm and checks the issuer and the subject itself.
 * Every failure is an AUTHENTICATION_FAILED or MISCONFIGURED adapter error; callers answer generically.
 */
export class OpenIdClientOidcGateway {
  /**
   * `discoveryOptions` exists for tests that run a local identity provider over plain HTTP; it replaces the outbound
   * guard. Production code never passes it (architecture test), so every request to an identity provider (discovery,
   * keys, token) goes through the SSRF-guarded fetch (F4, finding F4-S1). `outboundFetch` lets a test drive the guard
   * itself with a stubbed resolver and transport; production code never passes it either.
   */
  constructor(
    private readonly secrets: SecretResolver,
    private readonly discoveryOptions?: client.DiscoveryRequestOptions,
    private readonly outboundFetch: typeof fetch = createGuardedFetch(),
  ) {}

  async begin(
    context: ProviderOperationContext,
    profile: OidcProfile,
    config: OidcClientConfig,
  ): Promise<OidcAuthorizationResult> {
    return this.withConfig(context, profile, config, async (oidcConfig) => {
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();
      const authorizationUrl = client.buildAuthorizationUrl(oidcConfig, {
        redirect_uri: config.redirectUri,
        scope: config.scope ?? "openid profile email",
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
    profile: OidcProfile,
    config: OidcClientConfig,
    input: OidcCallback,
  ): Promise<OidcVerifiedClaims> {
    return this.withConfig(context, profile, config, async (oidcConfig) => {
      const tokens = await client.authorizationCodeGrant(oidcConfig, new URL(input.currentUrl), {
        pkceCodeVerifier: input.codeVerifier,
        expectedState: input.expectedState,
        expectedNonce: input.expectedNonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw failed(`No claims in ${profile.displayName} token`, "NO_CLAIMS");
      // openid-client already compares iss with the discovered issuer; the configured issuer is checked as well.
      if (claims.iss !== config.issuer) throw failed(`${profile.displayName} issuer mismatch`, "ISSUER_MISMATCH");
      const subject = claims[profile.subjectClaim];
      if (typeof subject !== "string" || !subject) {
        throw failed(`Missing ${profile.subjectClaim} in ${profile.displayName} token`, `MISSING_${profile.subjectClaim.toUpperCase()}`);
      }
      return { subject, issuer: claims.iss, claims: { ...claims } };
    });
  }

  async logoutUrl(
    context: ProviderOperationContext,
    profile: OidcProfile,
    config: OidcClientConfig,
    postLogoutRedirectUri: string,
  ): Promise<string | null> {
    return this.withConfig(context, profile, config, async (oidcConfig) => {
      const endpoint = oidcConfig.serverMetadata().end_session_endpoint;
      if (!endpoint) return null;
      const url = new URL(endpoint);
      url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
      return url.href;
    });
  }

  private async withConfig<T>(
    context: ProviderOperationContext,
    profile: OidcProfile,
    config: OidcClientConfig,
    action: (oidcConfig: client.Configuration) => Promise<T>,
  ): Promise<T> {
    if (!config.issuer || !config.clientId || !config.clientSecret) {
      throw new ProviderAdapterError({
        code: "MISCONFIGURED",
        message: `Missing ${profile.displayName} OIDC configuration`,
        safeDetails: { providerConnectionId: context.providerConnectionId },
      });
    }
    try {
      return await this.secrets.withSecret(context, config.clientSecret, (lease) =>
        lease.use(async (secretBytes) => {
          const guarded = this.outboundFetch as unknown as client.CustomFetch;
          const oidcConfig = await client.discovery(
            new URL(config.issuer),
            config.clientId,
            {
              client_secret: new TextDecoder().decode(secretBytes),
              id_token_signed_response_alg: config.idTokenAlgorithm ?? "RS256",
            },
            undefined,
            this.discoveryOptions ?? { [client.customFetch]: guarded },
          );
          // The same guard for every later request of this configuration: keys (JWKS) and the token endpoint.
          if (!this.discoveryOptions) oidcConfig[client.customFetch] = guarded;
          // Discovery must publish exactly the configured issuer (no trailing-slash or case drift).
          if (oidcConfig.serverMetadata().issuer !== config.issuer) {
            throw failed(`${profile.displayName} discovery issuer mismatch`, "DISCOVERY_ISSUER_MISMATCH");
          }
          // The ID token's signature is checked against the issuer's published keys (JWKS). openid-client skips this by
          // default for tokens received over TLS from the token endpoint, as OIDC allows; LUXIA does not (rule R8: a key
          // the issuer did not publish is refused). Found by the F1 test: without it such a token was accepted.
          client.enableNonRepudiationChecks(oidcConfig);
          return action(oidcConfig);
        }),
      );
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      const reason = outboundRefusal(error);
      throw new ProviderAdapterError({
        code: "AUTHENTICATION_FAILED",
        message: `${profile.displayName} OIDC operation failed`,
        ...(reason ? { safeDetails: { reason } } : {}),
      });
    }
  }
}

/** The guard's safe reason, when an outbound refusal caused the failure (openid-client may wrap it as a cause). */
function outboundRefusal(error: unknown): string | null {
  for (let current = error, depth = 0; current && depth < 5; current = (current as { cause?: unknown }).cause, depth++) {
    if (current instanceof OutboundRefusedError) return current.reason;
  }
  return null;
}

function failed(message: string, reason: string): ProviderAdapterError {
  return new ProviderAdapterError({ code: "AUTHENTICATION_FAILED", message, safeDetails: { reason } });
}
