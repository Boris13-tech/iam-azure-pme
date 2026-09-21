import type { ProviderOperationContext, SecretReference } from "../..";

export const LUXIA_LOCAL_PROVIDER_TYPE = "LUXIA_LOCAL" as const;

export type LocalCredentialType =
  | "PASSKEY"
  | "TOTP"
  | "SECURITY_KEY"
  | "SMART_CARD"
  | "MANAGED_DEVICE"
  | "CUSTOM";

export type LocalIdentityRecord = Readonly<{
  identityAccountId: string;
  subjectId: string;
  externalObjectId: string;
  displayName: string;
  principalName: string;
  status: "ACTIVE" | "DISABLED" | "LOCKED" | "RECOVERY_REQUIRED";
  failedAttempts: number;
  lockedUntil?: string;
}>;

export type LocalAuthenticatorRecord = Readonly<{
  id: string;
  identityAccountId: string;
  type: LocalCredentialType;
  status: "ACTIVE" | "REVOKED";
  credentialId?: string;
  publicKey?: string;
  secretRef?: SecretReference;
  relyingPartyId?: string;
  allowedOrigin?: string;
  signCount: number;
  lastTotpStep?: number;
}>;

export type LocalChallengeRecord = Readonly<{
  id: string;
  identityAccountId: string;
  purpose: "AUTHENTICATION" | "ENROLLMENT" | "RECOVERY";
  challengeHash: string;
  expiresAt: string;
  usedAt?: string;
  attempts: number;
  maxAttempts: number;
}>;

export interface LocalIdentityStore {
  assertLocalConnection(context: ProviderOperationContext): Promise<void>;
  createIdentity(context: ProviderOperationContext, input: {
    subjectId: string; displayName: string; principalName: string; externalObjectId: string;
  }): Promise<LocalIdentityRecord>;
  getIdentity(context: ProviderOperationContext, externalObjectId: string): Promise<LocalIdentityRecord | null>;
  findIdentityByPrincipal(context: ProviderOperationContext, principalName: string): Promise<LocalIdentityRecord | null>;
  listIdentities(context: ProviderOperationContext): Promise<ReadonlyArray<LocalIdentityRecord>>;
  disableIdentity(context: ProviderOperationContext, externalObjectId: string): Promise<LocalIdentityRecord>;
  listAuthenticators(context: ProviderOperationContext, identityAccountId: string): Promise<ReadonlyArray<LocalAuthenticatorRecord>>;
  saveAuthenticator(context: ProviderOperationContext, authenticator: LocalAuthenticatorRecord): Promise<void>;
  revokeAuthenticator(context: ProviderOperationContext, authenticatorId: string): Promise<void>;
  saveChallenge(context: ProviderOperationContext, challenge: LocalChallengeRecord): Promise<void>;
  getChallenge(context: ProviderOperationContext, challengeId: string): Promise<LocalChallengeRecord | null>;
  consumeChallenge(context: ProviderOperationContext, challengeId: string, now: string): Promise<boolean>;
  recordChallengeFailure(context: ProviderOperationContext, challengeId: string): Promise<void>;
  recordFailure(context: ProviderOperationContext, identityAccountId: string, lockedUntil?: string): Promise<void>;
  recordSuccess(context: ProviderOperationContext, identityAccountId: string): Promise<void>;
  advanceAuthenticator(context: ProviderOperationContext, authenticatorId: string, update: { signCount?: number; lastTotpStep?: number }): Promise<boolean>;
  saveRecoveryCode(context: ProviderOperationContext, input: { identityAccountId: string; codeHash: string; expiresAt?: string }): Promise<void>;
  consumeRecoveryCode(context: ProviderOperationContext, identityAccountId: string, codeHash: string, now: string): Promise<boolean>;
}

export type PasskeyAssertion = Readonly<{
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}>;
