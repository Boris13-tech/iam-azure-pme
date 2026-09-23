import { Prisma } from "@prisma/client";
import { withTenantDb } from "./scoped-client";
import { ContinuitySecurityError, continuityDigest, type ContinuityState, type SignedAssuranceSnapshot } from "../identity/continuity";
import type {
  ContinuityEvent, ContinuityScope, IdentityContinuityStore, LocalCredentialCheckpoint, StoredContinuityConflict, StoredOfflineChallenge,
} from "../identity/continuity-store";

export class PrismaIdentityContinuityStore implements IdentityContinuityStore {
  getState(scope: ContinuityScope): Promise<ContinuityState | null> {
    return withTenantDb(scope, async (tx) => {
      const row = await tx.identityContinuityState.findUnique({ where: { organizationId_tenantId: scope } });
      return row ? { ...scope, mode: row.mode, partitionEpoch: safeNumber(row.partitionEpoch), sequence: safeNumber(row.sequence),
        enteredAt: row.enteredAt.toISOString(), lastConnectedAt: row.lastConnectedAt?.toISOString() } : null;
    });
  }

  async saveState(scope: ContinuityScope, expectedSequence: number, next: ContinuityState): Promise<boolean> {
    assertScope(scope, next); safeInteger(expectedSequence);
    return withTenantDb(scope, async (tx) => {
      const updated = await tx.identityContinuityState.updateMany({ where: { ...scope, sequence: BigInt(expectedSequence) }, data: {
        mode: next.mode, partitionEpoch: BigInt(next.partitionEpoch), sequence: BigInt(next.sequence), enteredAt: new Date(next.enteredAt),
        lastConnectedAt: next.lastConnectedAt ? new Date(next.lastConnectedAt) : null,
      } });
      if (updated.count === 1) return true;
      if (expectedSequence !== 0 || await tx.identityContinuityState.findUnique({ where: { organizationId_tenantId: scope } })) return false;
      try {
        await tx.identityContinuityState.create({ data: { ...scope, mode: next.mode, partitionEpoch: BigInt(next.partitionEpoch),
          sequence: BigInt(next.sequence), enteredAt: new Date(next.enteredAt), lastConnectedAt: next.lastConnectedAt ? new Date(next.lastConnectedAt) : null } });
        return true;
      } catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false; throw error; }
    });
  }

  async commitStateTransition(scope: ContinuityScope, expectedSequence: number, next: ContinuityState, event: ContinuityEvent): Promise<boolean> {
    assertScope(scope, next); assertScope(scope, event); safeInteger(expectedSequence);
    return withTenantDb(scope, async (tx) => {
      const updated = await tx.identityContinuityState.updateMany({ where: { ...scope, sequence: BigInt(expectedSequence) }, data: {
        mode: next.mode, partitionEpoch: BigInt(next.partitionEpoch), sequence: BigInt(next.sequence), enteredAt: new Date(next.enteredAt),
        lastConnectedAt: next.lastConnectedAt ? new Date(next.lastConnectedAt) : null,
      } });
      if (updated.count !== 1) return false;
      await tx.identityContinuityEvent.create({ data: eventData(scope, event) });
      return true;
    });
  }

  reserveSequence(scope: ContinuityScope, expectedPartitionEpoch: number): Promise<number> {
    safeInteger(expectedPartitionEpoch);
    return withTenantDb(scope, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ sequence: bigint }>>`
        UPDATE "IdentityContinuityState"
        SET "sequence" = "sequence" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "organizationId" = ${scope.organizationId}
          AND "tenantId" = ${scope.tenantId}
          AND "partitionEpoch" = ${BigInt(expectedPartitionEpoch)}
        RETURNING "sequence"`;
      if (rows.length !== 1) throw new ContinuitySecurityError("EPOCH_MISMATCH");
      return safeNumber(rows[0].sequence);
    });
  }

  async saveChallenge(scope: ContinuityScope, value: StoredOfflineChallenge): Promise<void> {
    assertScope(scope, value);
    await withTenantDb(scope, async (tx) => { await tx.offlineIdentityChallenge.create({ data: {
      id: value.id, ...scope, subjectId: value.subjectId, verifierId: value.verifierId, audience: value.audience, purpose: value.purpose,
      nonceDigest: value.nonceDigest, partitionEpoch: BigInt(value.partitionEpoch), continuityMode: value.continuityMode,
      algorithmId: value.algorithmId, algorithmVersion: value.algorithmVersion, issuerKeyId: value.issuerKeyId,
      issuerKeyVersion: value.issuerKeyVersion, challengeSignature: value.challengeSignature,
      issuedAt: new Date(value.issuedAt), expiresAt: new Date(value.expiresAt), consumedAt: value.consumedAt ? new Date(value.consumedAt) : null,
    } }); });
  }
  getChallenge(scope: ContinuityScope, id: string): Promise<StoredOfflineChallenge | null> {
    return withTenantDb(scope, async (tx) => {
      const row = await tx.offlineIdentityChallenge.findFirst({ where: { id, ...scope } });
      return row ? { id: row.id, ...scope, subjectId: row.subjectId, verifierId: row.verifierId, audience: row.audience,
        purpose: row.purpose, nonceDigest: row.nonceDigest, partitionEpoch: safeNumber(row.partitionEpoch), continuityMode: row.continuityMode,
        algorithmId: row.algorithmId, algorithmVersion: row.algorithmVersion, issuerKeyId: row.issuerKeyId,
        issuerKeyVersion: row.issuerKeyVersion, challengeSignature: row.challengeSignature, issuedAt: row.issuedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(), consumedAt: row.consumedAt?.toISOString() } : null;
    });
  }
  consumeChallenge(scope: ContinuityScope, id: string, consumedAt: string): Promise<boolean> {
    return withTenantDb(scope, async (tx) => (await tx.offlineIdentityChallenge.updateMany({ where: {
      id, ...scope, consumedAt: null, expiresAt: { gt: new Date(consumedAt) },
    }, data: { consumedAt: new Date(consumedAt) } })).count === 1);
  }

  getLocalCredentialCheckpoint(scope: ContinuityScope, subjectId: string, credentialId: string, now: string): Promise<LocalCredentialCheckpoint | null> {
    return withTenantDb(scope, async (tx) => {
      const subject = await tx.subject.findFirst({ where: { id: subjectId, ...scope }, select: { lifecycleState: true, lifecycleVersion: true } });
      if (!subject) return null;
      const credential = await tx.localAuthenticator.findFirst({ where: { id: credentialId, ...scope,
        localIdentity: { identityAccount: { subjectId } } }, select: { id: true, status: true, stateVersion: true, expiresAt: true } });
      if (!credential) return null;
      const expired = credential.expiresAt !== null && credential.expiresAt.getTime() <= Date.parse(now);
      const credentialState: LocalCredentialCheckpoint["credentialState"] = expired ? "EXPIRED" :
        credential.status === "ACTIVE" ? "ACTIVE" : credential.status === "REVOKED" ? "REVOKED" :
          credential.status === "COMPROMISED" ? "COMPROMISED" : credential.status === "EXPIRED" ? "EXPIRED" : "UNAVAILABLE";
      return { subjectId, lifecycleState: subject.lifecycleState, lifecycleVersion: subject.lifecycleVersion,
        credentialId, credentialState, credentialStateVersion: credential.stateVersion };
    });
  }

  async saveSnapshot(scope: ContinuityScope, snapshot: SignedAssuranceSnapshot): Promise<void> {
    assertScope(scope, snapshot.payload);
    const value = snapshot.payload;
    await withTenantDb(scope, async (tx) => { await tx.identityAssuranceSnapshot.create({ data: {
      id: value.snapshotId, ...scope, subjectId: value.subjectId, schemaVersion: value.schemaVersion, issuer: value.issuer,
      audience: value.audience, purpose: value.purpose, scopeDigest: continuityDigest(value.scope),
      evidenceDigest: continuityDigest(value.evidenceDigests), assuranceProfile: value.assurance.profile,
      assuranceLevel: value.assurance.level, partitionEpoch: BigInt(value.partitionEpoch), sequence: BigInt(value.sequence),
      lifecycleVersion: BigInt(value.lifecycleVersion), credentialStateVersion: BigInt(value.credentialStateVersion),
      algorithmId: snapshot.signature.algorithmId, algorithmVersion: snapshot.signature.algorithmVersion,
      issuerKeyId: snapshot.signature.keyId, issuerKeyVersion: snapshot.signature.keyVersion, signature: snapshot.signature.value,
      issuedAt: new Date(value.issuedAt), expiresAt: new Date(value.expiresAt),
    } }); });
  }
  async appendEvent(scope: ContinuityScope, value: ContinuityEvent): Promise<void> {
    assertScope(scope, value);
    await withTenantDb(scope, async (tx) => { await tx.identityContinuityEvent.create({ data: eventData(scope, value) }); });
  }
  async saveConflict(scope: ContinuityScope, value: StoredContinuityConflict): Promise<void> {
    assertScope(scope, value);
    await withTenantDb(scope, async (tx) => { await tx.identityContinuityConflict.create({ data: {
      id: value.id, ...scope, subjectId: value.subjectId, entityType: value.entityType, entityId: value.entityId,
      localVersion: BigInt(value.localVersion), remoteVersion: BigInt(value.remoteVersion), localDigest: value.localDigest,
      remoteDigest: value.remoteDigest, reasonCode: value.reasonCode,
    } }); });
  }
}

function assertScope(scope: ContinuityScope, value: { organizationId: string; tenantId: string }): void {
  if (scope.organizationId !== value.organizationId || scope.tenantId !== value.tenantId) throw new ContinuitySecurityError("INVALID_SCOPE");
}
function safeNumber(value: bigint): number { const number = Number(value); safeInteger(number); return number; }
function safeInteger(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new ContinuitySecurityError("FRESHNESS_UNAVAILABLE"); }
function eventData(scope: ContinuityScope, value: ContinuityEvent) {
  return { id: value.id, ...scope, subjectId: value.subjectId, eventType: value.eventType, mode: value.mode,
    partitionEpoch: BigInt(value.partitionEpoch), sequence: BigInt(value.sequence), operationId: value.operationId,
    reasonCode: value.reasonCode, evidenceDigest: value.evidenceDigest, occurredAt: new Date(value.occurredAt) };
}
