import { createAuthenticationEvidence } from "../../../identity";
import {
  ProviderAdapterError,
  assertProviderOperationContext,
  type AuthChallenge,
  type AuthenticationProvider,
  type BeginAuthentication,
  type CompleteAuthentication,
  type ProviderOperationContext,
  type VerifiedExternalIdentity,
} from "../..";
import { checkOutboundTarget, OutboundRefusedError, type Resolve } from "../../infrastructure/outbound/guarded-fetch";
import type { OidcClientConfig, OidcProfile } from "../oidc";
import type { OpenIdClientOidcGateway } from "../oidc";

// F4, slice S4 (docs/architecture/F4-GENERIC-OIDC-CONNECTIONS-DESIGN.md, section 4, "Sign in"): a generic OIDC
// connection is a profile of the F1 core, nothing more. The core does every protocol check (code + PKCE S256, state,
// nonce, exact issuer, audience, signature against the published keys, pinned algorithm, expiry and issue time); this
// provider only adds the per-connection configuration and maps the verified token to `sub`. No claim other than the
// issuer leaves it: claims never become authority (rule R6), and nothing is created from them.
export const OIDC_GENERIC_PROVIDER_TYPE = "OIDC_GENERIC";
export const OIDC_GENERIC_PROFILE: OidcProfile = Object.freeze({ displayName: "OIDC", subjectClaim: "sub" });

/**
 * The configuration of one generic connection, with its client secret as an F3 reference (never a value), and the
 * configurationHash the database computed for it (slice S2). A round trip is bound to that hash when it starts.
 */
export type GenericOidcConnectionConfig = Readonly<{ client: OidcClientConfig; configurationHash: string }>;
export interface GenericOidcConfigResolver {
  resolve(context: ProviderOperationContext): Promise<GenericOidcConnectionConfig>;
}

export class GenericOidcAuthenticationProvider implements AuthenticationProvider {
  readonly type = OIDC_GENERIC_PROVIDER_TYPE;

  /** `resolve` exists for tests (stubbed DNS); production code never passes it. */
  constructor(
    private readonly configs: GenericOidcConfigResolver,
    private readonly oidc: OpenIdClientOidcGateway,
    private readonly resolve?: Resolve,
  ) {}

  async beginAuthentication(request: BeginAuthentication): Promise<AuthChallenge> {
    assertProviderOperationContext(request.context);
    const config = await this.configs.resolve(request.context);
    const result = await this.oidc.begin(request.context, OIDC_GENERIC_PROFILE, config.client);
    // The browser is only sent to an HTTPS authorization endpoint on a public host (design, section 3), checked again
    // at every sign-in because the provider's discovery document may change after the connection test.
    try {
      await checkOutboundTarget(result.authorizationUrl, this.resolve);
    } catch (error) {
      throw new ProviderAdapterError({
        code: "AUTHENTICATION_FAILED",
        message: "OIDC authorization endpoint refused",
        safeDetails: { reason: error instanceof OutboundRefusedError ? error.reason : "OUTBOUND_URL" },
      });
    }
    return {
      transactionId: result.state,
      kind: "REDIRECT",
      redirectUrl: result.authorizationUrl,
      // Stored server-side in the AuthTransaction: the callback completes against this exact configuration or not at all.
      continuation: { nonce: result.nonce, codeVerifier: result.codeVerifier, configurationHash: config.configurationHash },
      expiresAt: result.expiresAt,
    };
  }

  async completeAuthentication(request: CompleteAuthentication): Promise<VerifiedExternalIdentity> {
    const context = request.context;
    assertProviderOperationContext(context);
    for (const field of ["currentUrl", "codeVerifier", "expectedState", "expectedNonce", "expectedConfigurationHash"] as const) {
      if (!request.response[field]) {
        throw new ProviderAdapterError({ code: "INVALID_REQUEST", message: `Missing authentication response field '${field}'` });
      }
    }
    const config = await this.configs.resolve(context);
    // The configuration the round trip started with, or nothing: no request reaches the provider otherwise.
    if (config.configurationHash !== request.response.expectedConfigurationHash) {
      throw new ProviderAdapterError({
        code: "AUTHENTICATION_FAILED",
        message: "OIDC configuration changed during the sign-in",
        safeDetails: { reason: "CONFIGURATION_CHANGED" },
      });
    }
    const verified = await this.oidc.complete(context, OIDC_GENERIC_PROFILE, config.client, {
      currentUrl: request.response.currentUrl,
      codeVerifier: request.response.codeVerifier,
      expectedState: request.response.expectedState,
      expectedNonce: request.response.expectedNonce,
    });
    const authenticatedAt = new Date().toISOString();
    return {
      identity: { externalObjectId: verified.subject },
      assuranceLevel: "OIDC_GENERIC",
      authenticatedAt,
      // The issuer only: no e-mail, name, group or role is passed on, so none can be used to find or empower anyone.
      attributes: { iss: verified.issuer },
      evidence: createAuthenticationEvidence({
        organizationId: context.organizationId,
        tenantId: context.tenantId,
        providerConnectionId: context.providerConnectionId,
        externalObjectId: verified.subject,
        method: "FEDERATED_OIDC",
        reasonCode: "OIDC_GENERIC_VERIFIED",
        assurance: {
          level: "LOW",
          profile: "oidc-generic",
          profileVersion: 1,
          phishingResistant: false,
          hardwareBound: false,
          userVerification: "PROVIDER_ASSERTED",
        },
        provenance: {
          schemaVersion: 1,
          source: "EXTERNAL_PROVIDER",
          sourceRef: this.type,
          verifierPolicyVersion: 1,
          operationId: context.operationId,
          occurredAt: authenticatedAt,
          offline: false,
        },
      }),
    };
  }
}
