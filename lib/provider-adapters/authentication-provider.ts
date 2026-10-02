import type { ProviderOperationContext, ExternalIdentityRef } from "./types";
import type { AuthenticationEvidenceEnvelope } from "../identity";

export type BeginAuthentication = Readonly<{
  context: ProviderOperationContext;
  returnTo?: string;
  loginHint?: string;
}>;

export type AuthChallenge = Readonly<{
  transactionId: string;
  kind: "REDIRECT" | "LOCAL_CHALLENGE";
  redirectUrl?: string;
  publicChallenge?: Readonly<Record<string, string | number | boolean>>;
  /** Adapter-owned state that must be stored server-side and never logged. */
  continuation?: Readonly<Record<string, string>>;
  expiresAt: string;
}>;

export type CompleteAuthentication = Readonly<{
  context: ProviderOperationContext;
  transactionId: string;
  response: Readonly<Record<string, string>>;
}>;

export type VerifiedExternalIdentity = Readonly<{
  identity: ExternalIdentityRef;
  /** Compatibility label retained while callers migrate to typed evidence. */
  assuranceLevel: string;
  authenticatedAt: string;
  attributes: Readonly<Record<string, string | number | boolean | null>>;
  evidence: AuthenticationEvidenceEnvelope;
}>;

export type BeginLogout = Readonly<{
  context: ProviderOperationContext;
  identity: ExternalIdentityRef;
  postLogoutRedirectUri?: string;
}>;

export type UpstreamLogout = Readonly<{
  redirectUrl: string;
}>;

export interface AuthenticationProvider {
  beginAuthentication(request: BeginAuthentication): Promise<AuthChallenge>;
  completeAuthentication(
    request: CompleteAuthentication,
  ): Promise<VerifiedExternalIdentity>;
  beginLogout?(request: BeginLogout): Promise<UpstreamLogout | null>;
}
