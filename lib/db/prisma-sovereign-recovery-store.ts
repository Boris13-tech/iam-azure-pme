import { withTenantDb } from "./scoped-client";
import { PortabilitySecurityError } from "../identity/portability";
import type { RecoveryCeremony } from "../identity/sovereign-recovery";

export async function activateSovereignRecovery(ceremony: RecoveryCeremony, now = new Date()): Promise<void> {
  if (ceremony.state !== "RESTORED_ISOLATED" || ceremony.approvals.length < ceremony.requiredApprovals ||
      new Set(ceremony.approvals.map((x) => x.authorityId)).size < ceremony.requiredApprovals)
    throw new PortabilitySecurityError("INVALID_FORMAT");
  const scope = { organizationId: ceremony.organizationId, tenantId: ceremony.tenantId };
  await withTenantDb(scope, async (tx) => {
    const state = await tx.identityContinuityState.updateMany({ where: { ...scope, recoveryEpoch: BigInt(ceremony.epochFrom) }, data: {
      recoveryEpoch: BigInt(ceremony.epochTo), partitionEpoch: { increment: 1 }, sequence: { increment: 1 },
      mode: "RECOVERING", enteredAt: now,
    } });
    if (state.count !== 1) throw new PortabilitySecurityError("STALE_RECOVERY_EPOCH");
    await tx.offlineIdentityChallenge.updateMany({ where: { ...scope, recoveryEpoch: { lt: BigInt(ceremony.epochTo) }, consumedAt: null }, data: { consumedAt: now } });
    await tx.identityAssuranceSnapshot.updateMany({ where: { ...scope, recoveryEpoch: { lt: BigInt(ceremony.epochTo) }, revokedAt: null }, data: { revokedAt: now } });
    await tx.session.updateMany({ where: { ...scope, recoveryEpoch: { lt: BigInt(ceremony.epochTo) }, revokedAt: null }, data: { revokedAt: now } });
    const ceremonyUpdate = await tx.identityRecoveryCeremony.updateMany({ where: { id: ceremony.id, ...scope, state: "RESTORED_ISOLATED",
      epochFrom: BigInt(ceremony.epochFrom), epochTo: BigInt(ceremony.epochTo) }, data: { state: "ACTIVATED", activatedAt: now } });
    const receiptUpdate = await tx.identityPortabilityReceipt.updateMany({ where: { packageId: ceremony.packageId, ...scope,
      direction: "IMPORT", status: "STAGED" }, data: { status: "APPLIED", appliedAt: now } });
    if (ceremonyUpdate.count !== 1 || receiptUpdate.count !== 1) throw new PortabilitySecurityError("RECOVERY_REPLAY");
  });
}
