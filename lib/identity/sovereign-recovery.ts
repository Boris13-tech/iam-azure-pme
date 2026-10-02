import { randomUUID } from "node:crypto";
import { canonicalBytes, continuityDigest, type ContinuitySignatureProvider, type DetachedContinuitySignature } from "./continuity";
import type { ContinuityScope } from "./continuity-store";
import { PortabilitySecurityError } from "./portability";

export type RecoveryApproval = Readonly<{ authorityId: string; approvedAt: string; signature: DetachedContinuitySignature }>;
export type RecoveryCeremony = Readonly<{ id: string; packageId: string; manifestDigest: string; organizationId: string; tenantId: string;
  epochFrom: number; epochTo: number; state: "REQUESTED" | "APPROVED" | "VERIFIED" | "RESTORED_ISOLATED" | "ACTIVATED" | "FAILED";
  requiredApprovals: number; isolatedEnvironment: true; approvals: ReadonlyArray<RecoveryApproval>; createdAt: string }>;

export function beginRecoveryCeremony(input: Readonly<{ scope: ContinuityScope; packageId: string; manifestDigest: string;
  currentRecoveryEpoch: number; isolatedEnvironment: boolean; requiredApprovals?: number; now?: Date }>): RecoveryCeremony {
  const required = input.requiredApprovals ?? 2;
  if (!input.isolatedEnvironment || required < 2 || input.currentRecoveryEpoch < 0 || !Number.isSafeInteger(input.currentRecoveryEpoch))
    throw new PortabilitySecurityError("INVALID_SCOPE");
  return Object.freeze({ id: randomUUID(), packageId: input.packageId, manifestDigest: input.manifestDigest, ...input.scope,
    epochFrom: input.currentRecoveryEpoch, epochTo: input.currentRecoveryEpoch + 1, state: "REQUESTED", requiredApprovals: required,
    isolatedEnvironment: true, approvals: [], createdAt: (input.now ?? new Date()).toISOString() });
}

export async function approveRecoveryCeremony(ceremony: RecoveryCeremony, authorityId: string,
  signer: ContinuitySignatureProvider, now = new Date()): Promise<RecoveryCeremony> {
  if (ceremony.state !== "REQUESTED" && ceremony.state !== "APPROVED") throw new PortabilitySecurityError("INVALID_FORMAT");
  if (!authorityId.trim() || ceremony.approvals.some((x) => x.authorityId === authorityId)) throw new PortabilitySecurityError("RECOVERY_REPLAY");
  const approvedAt = now.toISOString();
  const signature = await signer.sign(approvalBytes(ceremony, authorityId, approvedAt), "RECOVERY_MANIFEST", authorityId);
  if (signature.keyId !== authorityId) throw new PortabilitySecurityError("SIGNATURE_INVALID");
  const approvals = Object.freeze([...ceremony.approvals, Object.freeze({ authorityId, approvedAt, signature })]);
  return Object.freeze({ ...ceremony, approvals, state: approvals.length >= ceremony.requiredApprovals ? "APPROVED" : "REQUESTED" });
}

export async function markRecoveryVerified(ceremony: RecoveryCeremony, verifier: ContinuitySignatureProvider): Promise<RecoveryCeremony> {
  if (ceremony.state !== "APPROVED" || new Set(ceremony.approvals.map((x) => x.authorityId)).size < ceremony.requiredApprovals)
    throw new PortabilitySecurityError("INVALID_FORMAT");
  for (const approval of ceremony.approvals) {
    if (approval.signature.keyId !== approval.authorityId ||
        !await verifier.verify(approvalBytes(ceremony, approval.authorityId, approval.approvedAt), approval.signature, "RECOVERY_MANIFEST"))
      throw new PortabilitySecurityError("SIGNATURE_INVALID");
  }
  return Object.freeze({ ...ceremony, state: "VERIFIED" });
}
export function markRestoredInIsolation(ceremony: RecoveryCeremony): RecoveryCeremony {
  if (ceremony.state !== "VERIFIED" || !ceremony.isolatedEnvironment) throw new PortabilitySecurityError("INVALID_SCOPE");
  return Object.freeze({ ...ceremony, state: "RESTORED_ISOLATED" });
}
export function activationEvidence(ceremony: RecoveryCeremony): Readonly<{ ceremonyId: string; recoveryEpoch: number; digest: string }> {
  if (ceremony.state !== "RESTORED_ISOLATED") throw new PortabilitySecurityError("INVALID_FORMAT");
  return Object.freeze({ ceremonyId: ceremony.id, recoveryEpoch: ceremony.epochTo,
    digest: continuityDigest({ ceremonyId: ceremony.id, packageId: ceremony.packageId, manifestDigest: ceremony.manifestDigest,
      epochFrom: ceremony.epochFrom, epochTo: ceremony.epochTo, approvals: ceremony.approvals }) });
}

function approvalBytes(ceremony: RecoveryCeremony, authorityId: string, approvedAt: string): Uint8Array {
  return canonicalBytes({ ceremonyId: ceremony.id, packageId: ceremony.packageId, manifestDigest: ceremony.manifestDigest,
    epochFrom: ceremony.epochFrom, epochTo: ceremony.epochTo, authorityId, approvedAt });
}
