import type { ContinuityMode, ContinuityState, SignedAssuranceSnapshot } from "./continuity";

export type ContinuityScope = Readonly<{ organizationId: string; tenantId: string }>;
export type StoredOfflineChallenge = Readonly<{
  id: string; organizationId: string; tenantId: string; subjectId: string; verifierId: string;
  audience: string; purpose: string; nonceDigest: string; partitionEpoch: number; continuityMode: ContinuityMode;
  algorithmId: string; algorithmVersion: number; issuerKeyId: string; issuerKeyVersion: number;
  challengeSignature: string; issuedAt: string; expiresAt: string; consumedAt?: string;
}>;
export type ContinuityEvent = Readonly<{
  id: string; organizationId: string; tenantId: string; subjectId?: string;
  eventType: "MODE_TRANSITION" | "OFFLINE_CHALLENGE_ISSUED" | "OFFLINE_PROOF_VERIFIED" | "SNAPSHOT_ISSUED" |
    "SNAPSHOT_REJECTED" | "RECONCILIATION_STARTED" | "RECONCILIATION_APPLIED" | "RECONCILIATION_CONFLICT" | "RECONCILIATION_COMPLETED";
  mode: ContinuityMode; partitionEpoch: number; sequence: number; operationId: string;
  reasonCode: string; evidenceDigest?: string; occurredAt: string;
}>;
export type StoredContinuityConflict = Readonly<{
  id: string; organizationId: string; tenantId: string; subjectId?: string; entityType: string; entityId: string;
  localVersion: number; remoteVersion: number; localDigest: string; remoteDigest: string; reasonCode: string;
}>;
export type LocalCredentialCheckpoint = Readonly<{
  subjectId: string; lifecycleState: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "DISABLED" | "RECOVERY_REQUIRED" | "RETIRED";
  lifecycleVersion: number; credentialId: string; credentialState: "ACTIVE" | "REVOKED" | "COMPROMISED" | "EXPIRED" | "UNAVAILABLE";
  credentialStateVersion: number;
}>;

export interface IdentityContinuityStore {
  getState(scope: ContinuityScope): Promise<ContinuityState | null>;
  saveState(scope: ContinuityScope, expectedSequence: number, next: ContinuityState): Promise<boolean>;
  commitStateTransition(scope: ContinuityScope, expectedSequence: number, next: ContinuityState, event: ContinuityEvent): Promise<boolean>;
  reserveSequence(scope: ContinuityScope, expectedPartitionEpoch: number): Promise<number>;
  saveChallenge(scope: ContinuityScope, challenge: StoredOfflineChallenge): Promise<void>;
  getChallenge(scope: ContinuityScope, challengeId: string): Promise<StoredOfflineChallenge | null>;
  consumeChallenge(scope: ContinuityScope, challengeId: string, consumedAt: string): Promise<boolean>;
  getLocalCredentialCheckpoint(scope: ContinuityScope, subjectId: string, credentialId: string, now: string): Promise<LocalCredentialCheckpoint | null>;
  saveSnapshot(scope: ContinuityScope, snapshot: SignedAssuranceSnapshot): Promise<void>;
  appendEvent(scope: ContinuityScope, event: ContinuityEvent): Promise<void>;
  saveConflict(scope: ContinuityScope, conflict: StoredContinuityConflict): Promise<void>;
}
