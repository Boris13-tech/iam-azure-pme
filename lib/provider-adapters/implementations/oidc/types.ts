import type { SecretReference } from "../..";

// The generic OIDC core (docs/architecture/SOVEREIGN-PROVIDER-FEDERATION-LAYER-DESIGN.md, sections 4.2 and 4.3).
// It knows the OpenID Connect standard and nothing about any vendor: a provider is a profile on top of it.

/** One client registration at one issuer. */
export type OidcClientConfig = Readonly<{
  /** Exact issuer. Discovery must publish this same value, and every ID token must carry it. */
  issuer: string;
  clientId: string;
  clientSecret: SecretReference;
  redirectUri: string;
  /** Default: "openid profile email". */
  scope?: string;
  /** The only accepted ID token signature algorithm. Default: RS256 (never "none", never a shared-secret HMAC). */
  idTokenAlgorithm?: "RS256" | "PS256" | "ES256";
}>;

/** What a provider adds to the core: a name for errors, and the claim that holds its stable subject. */
export type OidcProfile = Readonly<{
  displayName: string;
  subjectClaim: string;
}>;

export type OidcAuthorizationResult = Readonly<{
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: string;
}>;

/** A verified ID token: signature, issuer, audience, expiry, nonce and state already checked. */
export type OidcVerifiedClaims = Readonly<{
  subject: string;
  issuer: string;
  claims: Readonly<Record<string, unknown>>;
}>;

export type OidcCallback = Readonly<{
  currentUrl: string;
  codeVerifier: string;
  expectedState: string;
  expectedNonce: string;
}>;
