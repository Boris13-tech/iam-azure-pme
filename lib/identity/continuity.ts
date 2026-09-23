import { createHash } from "node:crypto";
import type { AuthenticationAssurance, SubjectLifecycleState } from "./semantics";

export const CONTINUITY_MODES = ["CONNECTED", "DEGRADED", "PARTITIONED", "OFFLINE", "RECOVERING"] as const;
export type ContinuityMode = (typeof CONTINUITY_MODES)[number];

export type ContinuityState = Readonly<{
  organizationId: string;
  tenantId: string;
  mode: ContinuityMode;
  partitionEpoch: number;
  sequence: number;
  enteredAt: string;
  lastConnectedAt?: string;
}>;

export class ContinuitySecurityError extends Error {
  constructor(readonly code:
    | "INVALID_MODE_TRANSITION" | "INVALID_SCOPE" | "FRESHNESS_UNAVAILABLE" | "EXPIRED"
    | "STALE_EVIDENCE" | "SIGNATURE_INVALID" | "REPLAY_DETECTED" | "EPOCH_MISMATCH"
    | "UNSUPPORTED_CRYPTO_VERSION" | "PRIVILEGE_INCREASE_DENIED" | "CONFLICT_QUARANTINED") {
    super(code); this.name = "ContinuitySecurityError";
  }
}

const transitions: Readonly<Record<ContinuityMode, ReadonlySet<ContinuityMode>>> = {
  CONNECTED: new Set(["DEGRADED", "PARTITIONED", "OFFLINE"]),
  DEGRADED: new Set(["CONNECTED", "PARTITIONED", "OFFLINE", "RECOVERING"]),
  PARTITIONED: new Set(["OFFLINE", "RECOVERING"]),
  OFFLINE: new Set(["PARTITIONED", "RECOVERING"]),
  RECOVERING: new Set(["CONNECTED", "DEGRADED", "PARTITIONED", "OFFLINE"]),
};

export function transitionContinuityMode(current: ContinuityState, next: ContinuityMode, now: string, reconciliationComplete = false): ContinuityState {
  if (current.mode === next) return current;
  if (!transitions[current.mode].has(next) || (next === "CONNECTED" && current.mode === "RECOVERING" && !reconciliationComplete))
    throw new ContinuitySecurityError("INVALID_MODE_TRANSITION");
  const entersPartition = (next === "PARTITIONED" || next === "OFFLINE") &&
    current.mode !== "PARTITIONED" && current.mode !== "OFFLINE";
  return Object.freeze({ ...current, mode: next, enteredAt: now,
    partitionEpoch: current.partitionEpoch + (entersPartition ? 1 : 0), sequence: current.sequence + 1,
    ...(next === "CONNECTED" ? { lastConnectedAt: now } : {}) });
}

export function deriveContinuityMode(signal: Readonly<{
  localRuntimeAvailable: boolean; internetAvailable: boolean; controlPlaneReachable: boolean; providerReachable: boolean;
}>): ContinuityMode {
  if (!signal.localRuntimeAvailable) return "DEGRADED";
  if (!signal.internetAvailable) return "OFFLINE";
  if (!signal.controlPlaneReachable) return "PARTITIONED";
  if (!signal.providerReachable) return "DEGRADED";
  return "CONNECTED";
}

export type ContinuityRisk = "STANDARD" | "HIGH" | "PRIVILEGE_INCREASING";
export type ContinuityUseConstraint = Readonly<{
  authenticationAllowed: boolean;
  evidenceUse: "NORMAL" | "EXISTING_ACCESS_ONLY" | "AUTHENTICATION_ONLY" | "NONE";
  requireFreshLocalProof: boolean;
  reasonCode: string;
}>;

export function assessContinuityUse(mode: ContinuityMode, risk: ContinuityRisk, hasFreshLocalProof: boolean): ContinuityUseConstraint {
  if (risk === "PRIVILEGE_INCREASING" && mode !== "CONNECTED") return {
    authenticationAllowed: hasFreshLocalProof, evidenceUse: "NONE", requireFreshLocalProof: true, reasonCode: "OFFLINE_PRIVILEGE_INCREASE_DENIED",
  };
  if (mode === "RECOVERING") return {
    authenticationAllowed: hasFreshLocalProof, evidenceUse: "AUTHENTICATION_ONLY", requireFreshLocalProof: true, reasonCode: "RECONCILIATION_REQUIRED",
  };
  if (mode === "PARTITIONED" || mode === "OFFLINE") return {
    authenticationAllowed: hasFreshLocalProof, evidenceUse: risk === "HIGH" ? "AUTHENTICATION_ONLY" : "EXISTING_ACCESS_ONLY",
    requireFreshLocalProof: true, reasonCode: hasFreshLocalProof ? "BOUNDED_OFFLINE_EVIDENCE" : "FRESH_LOCAL_PROOF_REQUIRED",
  };
  if (mode === "DEGRADED") return {
    authenticationAllowed: hasFreshLocalProof, evidenceUse: hasFreshLocalProof ? "EXISTING_ACCESS_ONLY" : "NONE",
    requireFreshLocalProof: true, reasonCode: "PROVIDER_EVIDENCE_UNAVAILABLE",
  };
  return { authenticationAllowed: true, evidenceUse: "NORMAL", requireFreshLocalProof: false, reasonCode: "CONNECTED_EVIDENCE" };
}

export type DetachedContinuitySignature = Readonly<{
  algorithmId: string; algorithmVersion: number; keyId: string; keyVersion: number; value: string;
}>;
export type ContinuitySignatureUsage = "OFFLINE_CHALLENGE" | "OFFLINE_PROOF" | "ASSURANCE_SNAPSHOT";
/**
 * Implementations operate on locally available custody/trust material. Verify
 * must reject unknown, revoked or compromised key versions and must not fetch
 * provider state from the network while evaluating an offline proof.
 */
export interface ContinuitySignatureProvider {
  sign(payload: Uint8Array, usage: ContinuitySignatureUsage, keyId?: string): Promise<DetachedContinuitySignature>;
  verify(payload: Uint8Array, signature: DetachedContinuitySignature, usage: ContinuitySignatureUsage): Promise<boolean>;
}

export const DEFAULT_CONTINUITY_LIMITS = Object.freeze({
  maximumClockSkewMs: 120_000,
  maximumChallengeTtlMs: 300_000,
  maximumSnapshotTtlMs: 28_800_000,
});

export type AssuranceSnapshotPayload = Readonly<{
  schemaVersion: 1;
  snapshotId: string;
  organizationId: string;
  tenantId: string;
  subjectId: string;
  issuer: string;
  audience: string;
  purpose: string;
  scope: Readonly<{ providerConnectionIds: ReadonlyArray<string>; credentialIds: ReadonlyArray<string> }>;
  assurance: AuthenticationAssurance;
  evidenceDigests: ReadonlyArray<string>;
  lifecycleState: SubjectLifecycleState;
  lifecycleVersion: number;
  credentialStateVersion: number;
  continuityMode: ContinuityMode;
  partitionEpoch: number;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  authorizationUse: "EVIDENCE_ONLY";
  privilegeConstraint: "NO_PRIVILEGE_INCREASE";
}>;

export type SignedAssuranceSnapshot = Readonly<{ payload: AssuranceSnapshotPayload; signature: DetachedContinuitySignature }>;

export function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(stableStringify(value), "utf8");
}

export function continuityDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalBytes(value)).digest("base64url")}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) throw new ContinuitySecurityError("INVALID_SCOPE");
  if (typeof value === "number" && !Number.isFinite(value)) throw new ContinuitySecurityError("INVALID_SCOPE");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}
