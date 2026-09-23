import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CURRENT_TOTP_CRYPTO,
  CURRENT_WEBAUTHN_CRYPTO,
  createAuthenticationEvidence,
  type AuthenticationAssurance,
  type AuthenticationMethod,
} from "../../../identity";
import {
  PROVIDER_ADAPTER_CONTRACT_VERSION,
  ProviderAdapterError,
  ProviderIdempotencyConflictError,
  UnsupportedProviderCapabilityError,
  assertProviderOperationContext,
  type AuthChallenge,
  type AuthenticationProvider,
  type BeginAuthentication,
  type CompleteAuthentication,
  type CreateIdentityCommand,
  type DiscoveredIdentity,
  type ExternalIdentityRef,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderGroup,
  type ProviderHealth,
  type ProviderIdentity,
  type ProviderOperationContext,
  type ProviderResource,
  type ProvisionResult,
  type SecretReference,
  type SecretResolver,
  type SyncResult,
  type VerifiedExternalIdentity,
} from "../..";
import { verifyTotp } from "./totp";
import { verifyPasskeyAssertion } from "./webauthn";
import {
  LUXIA_LOCAL_PROVIDER_TYPE,
  type LocalAuthenticatorRecord,
  type LocalIdentityRecord,
  type LocalIdentityStore,
  type PasskeyAssertion,
} from "./types";

const capabilities = new Set<ProviderCapability>([
  "AUTHENTICATION", "IDENTITY_LIFECYCLE", "OFFLINE_OPERATION",
]);
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const mutationKey = (c: ProviderOperationContext) =>
  [c.organizationId, c.tenantId, c.providerConnectionId, c.operationId].join("\0");

export class LuxiaLocalAdapter implements ProviderAdapter, AuthenticationProvider {
  readonly type = LUXIA_LOCAL_PROVIDER_TYPE;
  readonly contractVersion = PROVIDER_ADAPTER_CONTRACT_VERSION;
  private readonly mutations = new Map<string, { fingerprint: string; result: ProvisionResult }>();

  constructor(
    private readonly store: LocalIdentityStore,
    private readonly secrets: SecretResolver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  capabilities(): ReadonlySet<ProviderCapability> { return new Set(capabilities); }

  async beginAuthentication(request: BeginAuthentication): Promise<AuthChallenge> {
    await this.validate(request.context, "AUTHENTICATION");
    if (!request.loginHint) invalid("A local principal name is required");
    const identity = await this.store.findIdentityByPrincipal(request.context, request.loginHint!.toLowerCase());
    if (!identity || identity.status === "DISABLED" ||
        (identity.lockedUntil && Date.parse(identity.lockedUntil) > this.now().getTime())) authFailed("IDENTITY_UNAVAILABLE");
    const authenticators = (await this.store.listAuthenticators(request.context, identity.identityAccountId))
      .filter((item) => item.status === "ACTIVE");
    if (authenticators.length === 0) authFailed("NO_ACTIVE_AUTHENTICATOR");
    const raw = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const expiresAt = new Date(this.now().getTime() + 5 * 60_000).toISOString();
    await this.store.saveChallenge(request.context, {
      id, identityAccountId: identity.identityAccountId, purpose: "AUTHENTICATION",
      challengeHash: hash(raw), expiresAt, attempts: 0, maxAttempts: 5,
    });
    return {
      transactionId: id, kind: "LOCAL_CHALLENGE", expiresAt,
      publicChallenge: {
        challenge: raw,
        credentialTypes: authenticators.map((item) => item.type).join(","),
      },
    };
  }

  async completeAuthentication(request: CompleteAuthentication): Promise<VerifiedExternalIdentity> {
    await this.validate(request.context, "AUTHENTICATION");
    const challenge = await this.store.getChallenge(request.context, request.transactionId);
    if (!challenge || challenge.purpose !== "AUTHENTICATION" || challenge.usedAt ||
        challenge.attempts >= challenge.maxAttempts || Date.parse(challenge.expiresAt) <= this.now().getTime())
      authFailed("CHALLENGE_INVALID_OR_EXPIRED");
    const rawChallenge = request.response.challenge;
    if (!rawChallenge || hash(rawChallenge) !== challenge.challengeHash) authFailed("CHALLENGE_MISMATCH");
    const identity = await this.store.getIdentity(request.context, request.response.externalObjectId ?? "");
    if (!identity || identity.identityAccountId !== challenge.identityAccountId) authFailed("IDENTITY_SCOPE_MISMATCH");
    const authenticators = await this.store.listAuthenticators(request.context, identity.identityAccountId);
    try {
      const verified = await this.verifyCredential(request.context, request.response, rawChallenge, identity.identityAccountId, authenticators);
      if (!await this.store.consumeChallenge(request.context, challenge.id, this.now().toISOString())) authFailed("CHALLENGE_ALREADY_USED");
      await this.store.recordSuccess(request.context, identity.identityAccountId);
      const authenticatedAt = this.now().toISOString();
      return {
        identity: { externalObjectId: identity.externalObjectId }, assuranceLevel: verified.compatibilityLabel,
        authenticatedAt,
        attributes: { subjectId: identity.subjectId, identityAccountId: identity.identityAccountId, provider: this.type },
        evidence: createAuthenticationEvidence({
          organizationId: request.context.organizationId,
          tenantId: request.context.tenantId,
          providerConnectionId: request.context.providerConnectionId,
          subjectId: identity.subjectId,
          identityAccountId: identity.identityAccountId,
          externalObjectId: identity.externalObjectId,
          method: verified.method,
          reasonCode: verified.reasonCode,
          assurance: verified.assurance,
          provenance: {
            schemaVersion: 1,
            source: "LOCAL_VERIFIER",
            sourceRef: this.type,
            verifierPolicyVersion: verified.crypto?.verifierPolicyVersion ?? 1,
            operationId: request.context.operationId,
            occurredAt: authenticatedAt,
            algorithmId: verified.crypto?.algorithmId,
            algorithmVersion: verified.crypto?.algorithmVersion,
            keyId: verified.crypto?.keyId,
            keyVersion: verified.crypto?.keyVersion?.toString(),
            trustAnchorId: verified.crypto?.trustAnchorId,
            trustAnchorVersion: verified.crypto?.trustAnchorVersion,
            offline: true,
          },
        }),
      };
    } catch (error) {
      const lock = identity.failedAttempts + 1 >= 5
        ? new Date(this.now().getTime() + 15 * 60_000).toISOString() : undefined;
      await this.store.recordFailure(request.context, identity.identityAccountId, lock);
      await this.store.recordChallengeFailure(request.context, challenge.id);
      throw error;
    }
  }

  async beginEnrollment(context: ProviderOperationContext, identityAccountId: string): Promise<AuthChallenge> {
    await this.validate(context, "AUTHENTICATION");
    const identity = (await this.store.listIdentities(context)).find((item) => item.identityAccountId === identityAccountId);
    if (!identity || identity.status !== "ACTIVE") authFailed("IDENTITY_UNAVAILABLE");
    const raw = randomBytes(32).toString("base64url"); const id = randomUUID();
    const expiresAt = new Date(this.now().getTime() + 5 * 60_000).toISOString();
    await this.store.saveChallenge(context, { id, identityAccountId, purpose: "ENROLLMENT", challengeHash: hash(raw), expiresAt, attempts: 0, maxAttempts: 1 });
    return { transactionId: id, kind: "LOCAL_CHALLENGE", publicChallenge: { challenge: raw }, expiresAt };
  }

  async enrollPasskey(context: ProviderOperationContext, input: {
    identityAccountId: string; enrollmentTransactionId: string; enrollmentChallenge: string;
    credentialId: string; publicKey: string; relyingPartyId: string; allowedOrigin: string;
  }): Promise<string> {
    await this.validate(context, "AUTHENTICATION");
    if (!input.credentialId || !input.publicKey || !input.relyingPartyId || !input.allowedOrigin) invalid("Incomplete passkey enrollment");
    await this.consumeEnrollment(context, input.identityAccountId, input.enrollmentTransactionId, input.enrollmentChallenge);
    const id = randomUUID();
    await this.store.saveAuthenticator(context, {
      id, identityAccountId: input.identityAccountId, type: "PASSKEY", status: "ACTIVE",
      credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", credentialFormatVersion: 1,
      ...CURRENT_WEBAUTHN_CRYPTO, keyId: id, keyVersion: 1,
      verifierPolicyVersion: 1, hardwareBound: false, userVerificationRequired: false,
      credentialId: input.credentialId, publicKey: input.publicKey,
      relyingPartyId: input.relyingPartyId, allowedOrigin: input.allowedOrigin, signCount: 0,
    });
    return id;
  }

  async enrollTotp(context: ProviderOperationContext, input: {
    identityAccountId: string; enrollmentTransactionId: string; enrollmentChallenge: string; secretRef: SecretReference;
  }): Promise<string> {
    await this.validate(context, "AUTHENTICATION");
    if (!input.secretRef.key.trim()) invalid("TOTP secret reference is required");
    await this.consumeEnrollment(context, input.identityAccountId, input.enrollmentTransactionId, input.enrollmentChallenge);
    const id = randomUUID();
    await this.store.saveAuthenticator(context, {
      id, identityAccountId: input.identityAccountId, type: "TOTP", status: "ACTIVE",
      credentialSchemaVersion: 2, credentialFormat: "RFC6238_TOTP", credentialFormatVersion: 1,
      ...CURRENT_TOTP_CRYPTO, keyId: id, keyVersion: 1,
      verifierPolicyVersion: 1, hardwareBound: false, userVerificationRequired: false,
      secretRef: input.secretRef, signCount: 0,
    });
    return id;
  }

  async revokeAuthenticator(context: ProviderOperationContext, authenticatorId: string): Promise<void> {
    await this.validate(context, "AUTHENTICATION");
    await this.store.revokeAuthenticator(context, authenticatorId);
  }

  async issueRecoveryCodes(context: ProviderOperationContext, identityAccountId: string, count = 8): Promise<ReadonlyArray<string>> {
    await this.validate(context, "AUTHENTICATION");
    if (count < 1 || count > 16) invalid("Recovery code count must be between 1 and 16");
    const codes: string[] = [];
    for (let index = 0; index < count; index++) {
      const code = randomBytes(18).toString("base64url");
      await this.store.saveRecoveryCode(context, { identityAccountId, codeHash: hash(code), expiresAt: new Date(this.now().getTime() + 30 * 24 * 60 * 60_000).toISOString() });
      codes.push(code);
    }
    return codes;
  }

  async *discoverUsers(context: ProviderOperationContext): AsyncIterable<DiscoveredIdentity> {
    await this.validate(context, "IDENTITY_LIFECYCLE");
    for (const identity of await this.store.listIdentities(context)) yield { identity: this.toIdentity(identity) };
  }
  async getUser(context: ProviderOperationContext, ref: ExternalIdentityRef): Promise<ProviderIdentity | null> {
    await this.validate(context, "IDENTITY_LIFECYCLE");
    const value = await this.store.getIdentity(context, ref.externalObjectId);
    return value ? this.toIdentity(value) : null;
  }
  async createIdentity(context: ProviderOperationContext, command: CreateIdentityCommand): Promise<ProvisionResult> {
    await this.validate(context, "IDENTITY_LIFECYCLE");
    if (!command.principalName) invalid("Local identity creation requires a principal name");
    return this.idempotent(context, "createIdentity", command, async () => {
      const externalObjectId = randomUUID();
      await this.store.createIdentity(context, {
        subjectId: command.subjectId, displayName: command.displayName,
        principalName: command.principalName!.toLowerCase(), externalObjectId,
      });
      return { operationId: context.operationId, status: "APPLIED", identity: { externalObjectId } };
    });
  }
  async disableIdentity(context: ProviderOperationContext, ref: ExternalIdentityRef): Promise<ProvisionResult> {
    await this.validate(context, "IDENTITY_LIFECYCLE");
    return this.idempotent(context, "disableIdentity", ref, async () => {
      await this.store.disableIdentity(context, ref.externalObjectId);
      return { operationId: context.operationId, status: "APPLIED", identity: ref };
    });
  }
  async *listGroups(context: ProviderOperationContext): AsyncIterable<ProviderGroup> { await this.unsupported(context, "GROUP_DISCOVERY"); }
  async *listResources(context: ProviderOperationContext): AsyncIterable<ProviderResource> { await this.unsupported(context, "RESOURCE_DISCOVERY"); }
  async grantAccess(context: ProviderOperationContext): Promise<ProvisionResult> { return this.unsupported(context, "ACCESS_PROVISIONING"); }
  async revokeAccess(context: ProviderOperationContext): Promise<ProvisionResult> { return this.unsupported(context, "ACCESS_PROVISIONING"); }
  async sync(context: ProviderOperationContext): Promise<SyncResult> { return this.unsupported(context, "INCREMENTAL_SYNC"); }
  async healthCheck(context: ProviderOperationContext): Promise<ProviderHealth> {
    try { await this.validate(context); return { status: "HEALTHY", checkedAt: this.now().toISOString() }; }
    catch (error) { return { status: "MISCONFIGURED", checkedAt: this.now().toISOString(), safeMessage: error instanceof Error ? error.message : "Local provider unavailable" }; }
  }

  private async verifyCredential(context: ProviderOperationContext, response: Readonly<Record<string, string>>, challenge: string, identityAccountId: string, authenticators: ReadonlyArray<LocalAuthenticatorRecord>): Promise<VerifiedLocalMethod> {
    if (response.credentialType === "RECOVERY_CODE") {
      if (!response.recoveryCode || !await this.store.consumeRecoveryCode(context, identityAccountId, hash(response.recoveryCode), this.now().toISOString())) authFailed("RECOVERY_CODE_INVALID");
      return localMethod("LOCAL_RECOVERY", "CUSTOM", "LOCAL_RECOVERY_CODE_VERIFIED", {
        level: "LOW", profile: "local-recovery", profileVersion: 1,
        phishingResistant: false, hardwareBound: false, userVerification: "NOT_VERIFIED",
      });
    }
    const authenticator = authenticators.find((item) => item.id === response.authenticatorId && item.status === "ACTIVE");
    if (!authenticator) authFailed("AUTHENTICATOR_UNAVAILABLE");
    if (authenticator.type === "TOTP") {
      if (!authenticator.secretRef || !response.totp) authFailed("TOTP_INVALID");
      const step = await this.secrets.withSecret<number | null>(context, authenticator.secretRef, async (lease) =>
        lease.read((secret) => verifyTotp(secret, response.totp, this.now().getTime(), authenticator.lastTotpStep, authenticator)));
      if (step === null || !await this.store.advanceAuthenticator(context, authenticator.id, { lastTotpStep: step })) authFailed("TOTP_INVALID_OR_REPLAYED");
      return localMethod("LOCAL_TOTP", "TOTP", "LOCAL_TOTP_VERIFIED", {
        level: "SUBSTANTIAL", profile: "local-totp", profileVersion: 1,
        phishingResistant: false, hardwareBound: false, userVerification: "NOT_VERIFIED",
      }, authenticator);
    }
    if (authenticator.type === "PASSKEY" || authenticator.type === "SECURITY_KEY") {
      const assertion = parsePasskey(response);
      const next = verifyPasskeyAssertion({ assertion, authenticator, expectedChallenge: challenge });
      if (!await this.store.advanceAuthenticator(context, authenticator.id, { signCount: next })) authFailed("PASSKEY_REPLAY_DETECTED");
      const securityKey = authenticator.type === "SECURITY_KEY";
      return localMethod(securityKey ? "LOCAL_SECURITY_KEY" : "LOCAL_PASSKEY", securityKey ? "SECURITY_KEY" : "PASSKEY", securityKey ? "LOCAL_SECURITY_KEY_ASSERTION_VERIFIED" : "LOCAL_PASSKEY_ASSERTION_VERIFIED", {
        level: "SUBSTANTIAL", profile: securityKey ? "local-security-key" : "local-passkey", profileVersion: 1,
        phishingResistant: true,
        hardwareBound: authenticator.hardwareBound,
        userVerification: authenticator.userVerificationRequired ? "VERIFIED" : "NOT_VERIFIED",
      }, authenticator);
    }
    throw new UnsupportedProviderCapabilityError(this.type, "AUTHENTICATION");
  }

  private async consumeEnrollment(context: ProviderOperationContext, identityAccountId: string, transactionId: string, rawChallenge: string): Promise<void> {
    const challenge = await this.store.getChallenge(context, transactionId);
    if (!challenge || challenge.identityAccountId !== identityAccountId || challenge.purpose !== "ENROLLMENT" ||
        challenge.usedAt || challenge.attempts >= challenge.maxAttempts || Date.parse(challenge.expiresAt) <= this.now().getTime() ||
        hash(rawChallenge) !== challenge.challengeHash || !await this.store.consumeChallenge(context, transactionId, this.now().toISOString()))
      authFailed("ENROLLMENT_CHALLENGE_INVALID");
  }

  private async validate(context: ProviderOperationContext, capability?: ProviderCapability): Promise<void> {
    assertProviderOperationContext(context);
    if (capability && !capabilities.has(capability)) throw new UnsupportedProviderCapabilityError(this.type, capability);
    await this.store.assertLocalConnection(context);
  }
  private async unsupported<T>(context: ProviderOperationContext, capability: ProviderCapability): Promise<T> {
    assertProviderOperationContext(context); throw new UnsupportedProviderCapabilityError(this.type, capability);
  }
  private toIdentity(value: LocalIdentityRecord): ProviderIdentity {
    return { ref: { externalObjectId: value.externalObjectId }, displayName: value.displayName,
      principalName: value.principalName, status: value.status === "ACTIVE" ? "ACTIVE" : "DISABLED",
      attributes: { subjectId: value.subjectId, identityAccountId: value.identityAccountId }, observedAt: this.now().toISOString() };
  }
  private async idempotent<T>(context: ProviderOperationContext, method: string, command: T, action: () => Promise<ProvisionResult>): Promise<ProvisionResult> {
    const key = mutationKey(context); const fingerprint = hash(JSON.stringify({ method, command })); const existing = this.mutations.get(key);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new ProviderIdempotencyConflictError(context.operationId); return existing.result; }
    const result = Object.freeze(await action()); this.mutations.set(key, { fingerprint, result }); return result;
  }
}

function parsePasskey(response: Readonly<Record<string, string>>): PasskeyAssertion {
  for (const key of ["credentialId", "clientDataJSON", "authenticatorData", "signature"] as const)
    if (!response[key]) invalid(`Missing passkey response field '${key}'`);
  return { credentialId: response.credentialId, clientDataJSON: response.clientDataJSON,
    authenticatorData: response.authenticatorData, signature: response.signature };
}
function invalid(message: string): never { throw new ProviderAdapterError({ code: "INVALID_REQUEST", message }); }
function authFailed(reason: string): never { throw new ProviderAdapterError({ code: "AUTHENTICATION_FAILED", message: "Local authentication failed", safeDetails: { reason } }); }

type VerifiedLocalMethod = Readonly<{
  compatibilityLabel: string;
  method: AuthenticationMethod;
  reasonCode: string;
  assurance: AuthenticationAssurance;
  crypto?: Readonly<Pick<LocalAuthenticatorRecord, "algorithmId" | "algorithmVersion" | "keyId" | "keyVersion" | "trustAnchorId" | "trustAnchorVersion" | "verifierPolicyVersion">>;
}>;

function localMethod(compatibilityLabel: string, method: AuthenticationMethod, reasonCode: string, assurance: AuthenticationAssurance, authenticator?: LocalAuthenticatorRecord): VerifiedLocalMethod {
  return { compatibilityLabel, method, reasonCode, assurance, crypto: authenticator ? {
    algorithmId: authenticator.algorithmId, algorithmVersion: authenticator.algorithmVersion,
    keyId: authenticator.keyId, keyVersion: authenticator.keyVersion,
    trustAnchorId: authenticator.trustAnchorId, trustAnchorVersion: authenticator.trustAnchorVersion,
    verifierPolicyVersion: authenticator.verifierPolicyVersion,
  } : undefined };
}
