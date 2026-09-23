import { randomBytes, randomUUID } from "node:crypto";
import { LUXIA_CRYPTO_ALGORITHMS } from "./crypto-agility";
import {
  DEFAULT_CONTINUITY_LIMITS, ContinuitySecurityError, canonicalBytes, continuityDigest,
  type AssuranceSnapshotPayload, type ContinuitySignatureProvider, type ContinuityState,
  type DetachedContinuitySignature, type SignedAssuranceSnapshot,
} from "./continuity";
import type { ContinuityScope, IdentityContinuityStore, LocalCredentialCheckpoint, StoredOfflineChallenge } from "./continuity-store";

export type OfflineChallengePayload = Readonly<{
  schemaVersion: 1; challengeId: string; organizationId: string; tenantId: string; subjectId: string;
  verifierId: string; audience: string; purpose: string; nonce: string; continuityMode: ContinuityState["mode"];
  partitionEpoch: number; issuedAt: string; expiresAt: string;
}>;
export type SignedOfflineChallenge = Readonly<{ payload: OfflineChallengePayload; signature: DetachedContinuitySignature }>;
export type OfflineProofPayload = Readonly<{
  schemaVersion: 1; challengeId: string; organizationId: string; tenantId: string; subjectId: string;
  credentialId: string; verifierId: string; audience: string; purpose: string; nonce: string;
  partitionEpoch: number; signedAt: string; snapshotDigest?: string;
  tokenSemantics: "ONE_TIME_CHALLENGE_RESPONSE";
}>;
export type SignedOfflineProof = Readonly<{ payload: OfflineProofPayload; signature: DetachedContinuitySignature }>;

export type VerifiedOfflineIdentityEvidence = Readonly<{
  evidenceType: "OFFLINE_IDENTITY_PROOF"; evidenceVersion: 1; organizationId: string; tenantId: string;
  subjectId: string; credentialId: string; challengeId: string; snapshotId?: string;
  partitionEpoch: number; verifiedAt: string; expiresAt: string; evidenceDigest: string;
  authorizationUse: "EVIDENCE_ONLY"; privilegeConstraint: "NO_PRIVILEGE_INCREASE"; reusableBearer: false;
}>;

export async function issueOfflineChallenge(input: Readonly<{
  scope: ContinuityScope; subjectId: string; verifierId: string; audience: string; purpose: string;
  state: ContinuityState; ttlMs?: number; now?: Date; nonce?: string;
}>, store: IdentityContinuityStore, signer: ContinuitySignatureProvider): Promise<SignedOfflineChallenge> {
  assertScope(input.scope, input.state);
  for (const value of [input.subjectId, input.verifierId, input.audience, input.purpose]) if (!value.trim()) throw new ContinuitySecurityError("INVALID_SCOPE");
  const ttl = input.ttlMs ?? DEFAULT_CONTINUITY_LIMITS.maximumChallengeTtlMs;
  if (ttl <= 0 || ttl > DEFAULT_CONTINUITY_LIMITS.maximumChallengeTtlMs) throw new ContinuitySecurityError("FRESHNESS_UNAVAILABLE");
  const now = input.now ?? new Date();
  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  if (Buffer.byteLength(nonce, "utf8") < 32) throw new ContinuitySecurityError("FRESHNESS_UNAVAILABLE");
  const payload: OfflineChallengePayload = Object.freeze({ schemaVersion: 1, challengeId: randomUUID(), ...input.scope,
    subjectId: input.subjectId, verifierId: input.verifierId, audience: input.audience, purpose: input.purpose,
    nonce, continuityMode: input.state.mode,
    partitionEpoch: input.state.partitionEpoch, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl).toISOString() });
  const signature = await signer.sign(canonicalBytes(payload), "OFFLINE_CHALLENGE");
  validateSignatureVersion(signature, "OFFLINE_CHALLENGE");
  await store.saveChallenge(input.scope, toStoredChallenge(payload, signature));
  const sequence = await store.reserveSequence(input.scope, input.state.partitionEpoch);
  await store.appendEvent(input.scope, { id: randomUUID(), ...input.scope, subjectId: input.subjectId,
    eventType: "OFFLINE_CHALLENGE_ISSUED", mode: input.state.mode, partitionEpoch: input.state.partitionEpoch,
    sequence, operationId: payload.challengeId, reasonCode: "FRESH_SIGNED_CHALLENGE_ISSUED",
    evidenceDigest: continuityDigest({ challengeId: payload.challengeId, signature }), occurredAt: now.toISOString() });
  return Object.freeze({ payload, signature });
}

export async function createOfflineProof(challenge: SignedOfflineChallenge, credentialId: string, signer: ContinuitySignatureProvider,
  options: Readonly<{ now?: Date; snapshot?: SignedAssuranceSnapshot }> = {}): Promise<SignedOfflineProof> {
  if (!credentialId.trim()) throw new ContinuitySecurityError("INVALID_SCOPE");
  const now = options.now ?? new Date();
  validateFreshness(challenge.payload.issuedAt, challenge.payload.expiresAt, now, DEFAULT_CONTINUITY_LIMITS.maximumChallengeTtlMs);
  validateSignatureVersion(challenge.signature, "OFFLINE_CHALLENGE");
  if (!await signer.verify(canonicalBytes(challenge.payload), challenge.signature, "OFFLINE_CHALLENGE"))
    throw new ContinuitySecurityError("SIGNATURE_INVALID");
  const payload: OfflineProofPayload = Object.freeze({ schemaVersion: 1, challengeId: challenge.payload.challengeId,
    organizationId: challenge.payload.organizationId, tenantId: challenge.payload.tenantId, subjectId: challenge.payload.subjectId,
    credentialId, verifierId: challenge.payload.verifierId, audience: challenge.payload.audience, purpose: challenge.payload.purpose,
    nonce: challenge.payload.nonce, partitionEpoch: challenge.payload.partitionEpoch,
    signedAt: now.toISOString(),
    ...(options.snapshot ? { snapshotDigest: continuityDigest(options.snapshot) } : {}), tokenSemantics: "ONE_TIME_CHALLENGE_RESPONSE" });
  const signature = await signer.sign(canonicalBytes(payload), "OFFLINE_PROOF", credentialId);
  validateSignatureVersion(signature, "OFFLINE_PROOF");
  if (signature.keyId !== credentialId) throw new ContinuitySecurityError("SIGNATURE_INVALID");
  return Object.freeze({ payload, signature });
}

export async function issueAssuranceSnapshot(input: Readonly<Omit<AssuranceSnapshotPayload,
  "schemaVersion" | "snapshotId" | "sequence" | "issuedAt" | "expiresAt" | "authorizationUse" | "privilegeConstraint"> &
  { ttlMs?: number; now?: Date }>, store: IdentityContinuityStore, signer: ContinuitySignatureProvider): Promise<SignedAssuranceSnapshot> {
  const ttl = input.ttlMs ?? DEFAULT_CONTINUITY_LIMITS.maximumSnapshotTtlMs;
  if (ttl <= 0 || ttl > DEFAULT_CONTINUITY_LIMITS.maximumSnapshotTtlMs || input.lifecycleVersion < 0 || input.credentialStateVersion < 0)
    throw new ContinuitySecurityError("FRESHNESS_UNAVAILABLE");
  for (const value of [input.organizationId, input.tenantId, input.subjectId, input.issuer, input.audience, input.purpose,
    input.assurance.profile]) if (!value.trim()) throw new ContinuitySecurityError("INVALID_SCOPE");
  if (input.evidenceDigests.length === 0 || input.evidenceDigests.some((digest) => !digest.startsWith("sha256:") || digest.length <= 7))
    throw new ContinuitySecurityError("STALE_EVIDENCE");
  const now = input.now ?? new Date(); const scope = { organizationId: input.organizationId, tenantId: input.tenantId };
  const sequence = await store.reserveSequence(scope, input.partitionEpoch);
  const payload: AssuranceSnapshotPayload = Object.freeze({ schemaVersion: 1, snapshotId: randomUUID(),
    organizationId: input.organizationId, tenantId: input.tenantId, subjectId: input.subjectId, issuer: input.issuer,
    audience: input.audience, purpose: input.purpose, scope: normalizeSnapshotScope(input.scope), assurance: input.assurance,
    evidenceDigests: [...input.evidenceDigests].sort(), lifecycleState: input.lifecycleState,
    lifecycleVersion: input.lifecycleVersion, credentialStateVersion: input.credentialStateVersion,
    continuityMode: input.continuityMode, partitionEpoch: input.partitionEpoch, sequence,
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl).toISOString(),
    authorizationUse: "EVIDENCE_ONLY", privilegeConstraint: "NO_PRIVILEGE_INCREASE" });
  const signature = await signer.sign(canonicalBytes(payload), "ASSURANCE_SNAPSHOT");
  validateSignatureVersion(signature, "ASSURANCE_SNAPSHOT");
  const snapshot = Object.freeze({ payload, signature });
  await store.saveSnapshot(scope, snapshot);
  await store.appendEvent(scope, { id: randomUUID(), ...scope, subjectId: input.subjectId, eventType: "SNAPSHOT_ISSUED",
    mode: input.continuityMode, partitionEpoch: input.partitionEpoch, sequence, operationId: payload.snapshotId,
    reasonCode: "BOUNDED_ASSURANCE_SNAPSHOT_ISSUED", evidenceDigest: continuityDigest(snapshot), occurredAt: now.toISOString() });
  return snapshot;
}

export async function verifyOfflineProof(input: Readonly<{
  scope: ContinuityScope; expectedSubjectId: string; expectedVerifierId: string; expectedAudience: string; expectedPurpose: string;
  state: ContinuityState; challenge: SignedOfflineChallenge; proof: SignedOfflineProof; snapshot?: SignedAssuranceSnapshot;
  operationId: string; now?: Date;
}>, store: IdentityContinuityStore, verifier: ContinuitySignatureProvider): Promise<VerifiedOfflineIdentityEvidence> {
  const now = input.now ?? new Date(); const challenge = input.challenge.payload; const proof = input.proof.payload;
  assertScope(input.scope, input.state);
  assertExpectedScope(input, challenge);
  validateFreshness(challenge.issuedAt, challenge.expiresAt, now, DEFAULT_CONTINUITY_LIMITS.maximumChallengeTtlMs);
  validateSignatureVersion(input.challenge.signature, "OFFLINE_CHALLENGE");
  if (!await verifier.verify(canonicalBytes(challenge), input.challenge.signature, "OFFLINE_CHALLENGE"))
    throw new ContinuitySecurityError("SIGNATURE_INVALID");
  const stored = await store.getChallenge(input.scope, challenge.challengeId);
  if (!stored || stored.consumedAt) throw new ContinuitySecurityError("REPLAY_DETECTED");
  if (stored.nonceDigest !== continuityDigest(challenge.nonce) || !storedMatches(stored, challenge, input.challenge.signature))
    throw new ContinuitySecurityError("SIGNATURE_INVALID");
  const persistedState = await store.getState(input.scope);
  if (!persistedState || challenge.partitionEpoch !== input.state.partitionEpoch || persistedState.partitionEpoch !== input.state.partitionEpoch ||
      persistedState.mode !== input.state.mode) throw new ContinuitySecurityError("EPOCH_MISMATCH");
  const checkpoint = await store.getLocalCredentialCheckpoint(input.scope, proof.subjectId, proof.credentialId, now.toISOString());
  if (!checkpoint || checkpoint.lifecycleState !== "ACTIVE" || checkpoint.credentialState !== "ACTIVE" ||
      !proofMatchesChallenge(proof, challenge))
    throw new ContinuitySecurityError("STALE_EVIDENCE");
  validateProofTime(proof.signedAt, challenge, now);
  validateSignatureVersion(input.proof.signature, "OFFLINE_PROOF");
  if (input.proof.signature.keyId !== proof.credentialId ||
      !await verifier.verify(canonicalBytes(proof), input.proof.signature, "OFFLINE_PROOF"))
    throw new ContinuitySecurityError("SIGNATURE_INVALID");
  let snapshotId: string | undefined;
  if (input.snapshot) {
    verifySnapshotBinding(input.snapshot, proof, input, checkpoint, now);
    if (!await verifier.verify(canonicalBytes(input.snapshot.payload), input.snapshot.signature, "ASSURANCE_SNAPSHOT"))
      throw new ContinuitySecurityError("SIGNATURE_INVALID");
    snapshotId = input.snapshot.payload.snapshotId;
  } else if (proof.snapshotDigest) throw new ContinuitySecurityError("STALE_EVIDENCE");
  if (!await store.consumeChallenge(input.scope, challenge.challengeId, now.toISOString()))
    throw new ContinuitySecurityError("REPLAY_DETECTED");
  const evidenceExpiresAt = input.snapshot && Date.parse(input.snapshot.payload.expiresAt) < Date.parse(challenge.expiresAt)
    ? input.snapshot.payload.expiresAt : challenge.expiresAt;
  const evidenceBase = { evidenceType: "OFFLINE_IDENTITY_PROOF" as const, evidenceVersion: 1 as const, ...input.scope,
    subjectId: proof.subjectId, credentialId: proof.credentialId, challengeId: proof.challengeId, ...(snapshotId ? { snapshotId } : {}),
    partitionEpoch: proof.partitionEpoch, verifiedAt: now.toISOString(), expiresAt: evidenceExpiresAt,
    authorizationUse: "EVIDENCE_ONLY" as const, privilegeConstraint: "NO_PRIVILEGE_INCREASE" as const, reusableBearer: false as const };
  const evidence = Object.freeze({ ...evidenceBase, evidenceDigest: continuityDigest(evidenceBase) });
  const sequence = await store.reserveSequence(input.scope, input.state.partitionEpoch);
  await store.appendEvent(input.scope, { id: randomUUID(), ...input.scope, subjectId: proof.subjectId,
    eventType: "OFFLINE_PROOF_VERIFIED", mode: input.state.mode, partitionEpoch: input.state.partitionEpoch,
    sequence, operationId: input.operationId, reasonCode: "FRESH_LOCAL_PROOF_VERIFIED",
    evidenceDigest: evidence.evidenceDigest, occurredAt: now.toISOString() });
  return evidence;
}

function validateSignatureVersion(signature: DetachedContinuitySignature, purpose: "OFFLINE_CHALLENGE" | "OFFLINE_PROOF" | "ASSURANCE_SNAPSHOT"): void {
  try { LUXIA_CRYPTO_ALGORITHMS.resolve(signature.algorithmId, signature.algorithmVersion, purpose, "VERIFY"); }
  catch { throw new ContinuitySecurityError("UNSUPPORTED_CRYPTO_VERSION"); }
  if (signature.keyVersion < 1 || !signature.keyId.trim() || !signature.value.trim()) throw new ContinuitySecurityError("SIGNATURE_INVALID");
}
function validateFreshness(issuedAt: string, expiresAt: string, now: Date, maxTtl: number): void {
  const issued = Date.parse(issuedAt), expires = Date.parse(expiresAt), current = now.getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > maxTtl ||
      issued - current > DEFAULT_CONTINUITY_LIMITS.maximumClockSkewMs) throw new ContinuitySecurityError("FRESHNESS_UNAVAILABLE");
  if (current >= expires) throw new ContinuitySecurityError("EXPIRED");
}
function validateProofTime(signedAt: string, challenge: OfflineChallengePayload, now: Date): void {
  const signed = Date.parse(signedAt);
  if (!Number.isFinite(signed) || signed < Date.parse(challenge.issuedAt) - DEFAULT_CONTINUITY_LIMITS.maximumClockSkewMs ||
      signed > now.getTime() + DEFAULT_CONTINUITY_LIMITS.maximumClockSkewMs || signed >= Date.parse(challenge.expiresAt))
    throw new ContinuitySecurityError("FRESHNESS_UNAVAILABLE");
}
function assertScope(scope: ContinuityScope, state: ContinuityState): void {
  if (scope.organizationId !== state.organizationId || scope.tenantId !== state.tenantId) throw new ContinuitySecurityError("INVALID_SCOPE");
}
function assertExpectedScope(input: Parameters<typeof verifyOfflineProof>[0], challenge: OfflineChallengePayload): void {
  if (challenge.organizationId !== input.scope.organizationId || challenge.tenantId !== input.scope.tenantId ||
      challenge.subjectId !== input.expectedSubjectId || challenge.verifierId !== input.expectedVerifierId ||
      challenge.audience !== input.expectedAudience || challenge.purpose !== input.expectedPurpose)
    throw new ContinuitySecurityError("INVALID_SCOPE");
}
function proofMatchesChallenge(proof: OfflineProofPayload, challenge: OfflineChallengePayload): boolean {
  return proof.challengeId === challenge.challengeId && proof.organizationId === challenge.organizationId &&
    proof.tenantId === challenge.tenantId && proof.subjectId === challenge.subjectId && proof.verifierId === challenge.verifierId &&
    proof.audience === challenge.audience && proof.purpose === challenge.purpose && proof.nonce === challenge.nonce &&
    proof.partitionEpoch === challenge.partitionEpoch && proof.tokenSemantics === "ONE_TIME_CHALLENGE_RESPONSE";
}
function storedMatches(stored: StoredOfflineChallenge, challenge: OfflineChallengePayload, signature: DetachedContinuitySignature): boolean {
  return stored.organizationId === challenge.organizationId && stored.tenantId === challenge.tenantId && stored.subjectId === challenge.subjectId &&
    stored.verifierId === challenge.verifierId && stored.audience === challenge.audience && stored.purpose === challenge.purpose &&
    stored.partitionEpoch === challenge.partitionEpoch && stored.continuityMode === challenge.continuityMode &&
    stored.algorithmId === signature.algorithmId && stored.algorithmVersion === signature.algorithmVersion &&
    stored.issuerKeyId === signature.keyId && stored.issuerKeyVersion === signature.keyVersion && stored.challengeSignature === signature.value;
}
function verifySnapshotBinding(snapshot: SignedAssuranceSnapshot, proof: OfflineProofPayload, input: Parameters<typeof verifyOfflineProof>[0], checkpoint: LocalCredentialCheckpoint, now: Date): void {
  const payload = snapshot.payload;
  validateFreshness(payload.issuedAt, payload.expiresAt, now, DEFAULT_CONTINUITY_LIMITS.maximumSnapshotTtlMs);
  validateSignatureVersion(snapshot.signature, "ASSURANCE_SNAPSHOT");
  if (proof.snapshotDigest !== continuityDigest(snapshot) || payload.organizationId !== input.scope.organizationId ||
      payload.tenantId !== input.scope.tenantId || payload.subjectId !== proof.subjectId || payload.audience !== proof.audience ||
      payload.purpose !== proof.purpose) throw new ContinuitySecurityError("INVALID_SCOPE");
  if (payload.partitionEpoch !== input.state.partitionEpoch) throw new ContinuitySecurityError("EPOCH_MISMATCH");
  if (payload.lifecycleState !== "ACTIVE" || checkpoint.lifecycleState !== "ACTIVE" || checkpoint.credentialState !== "ACTIVE" ||
      payload.lifecycleVersion !== checkpoint.lifecycleVersion || payload.credentialStateVersion !== checkpoint.credentialStateVersion ||
      (payload.scope.credentialIds.length > 0 && !payload.scope.credentialIds.includes(proof.credentialId)))
    throw new ContinuitySecurityError("STALE_EVIDENCE");
}
function normalizeSnapshotScope(scope: AssuranceSnapshotPayload["scope"]): AssuranceSnapshotPayload["scope"] {
  const providerConnectionIds = [...new Set(scope.providerConnectionIds)].sort();
  const credentialIds = [...new Set(scope.credentialIds)].sort();
  if (providerConnectionIds.some((id) => !id.trim()) || credentialIds.some((id) => !id.trim())) throw new ContinuitySecurityError("INVALID_SCOPE");
  return Object.freeze({ providerConnectionIds, credentialIds });
}
function toStoredChallenge(payload: OfflineChallengePayload, signature: DetachedContinuitySignature): StoredOfflineChallenge {
  return { id: payload.challengeId, organizationId: payload.organizationId, tenantId: payload.tenantId, subjectId: payload.subjectId,
    verifierId: payload.verifierId, audience: payload.audience, purpose: payload.purpose, nonceDigest: continuityDigest(payload.nonce),
    partitionEpoch: payload.partitionEpoch, continuityMode: payload.continuityMode, algorithmId: signature.algorithmId,
    algorithmVersion: signature.algorithmVersion, issuerKeyId: signature.keyId, issuerKeyVersion: signature.keyVersion,
    challengeSignature: signature.value, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt };
}
