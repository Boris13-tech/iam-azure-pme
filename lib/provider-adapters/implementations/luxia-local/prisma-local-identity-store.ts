import { Prisma } from "@prisma/client";
import { ProviderAdapterError, type ProviderOperationContext } from "../..";
import { withTenantDb } from "../../../db/scoped-client";
import type {
  LocalAuthenticatorRecord, LocalChallengeRecord, LocalIdentityRecord, LocalIdentityStore,
} from "./types";

type Tx = Prisma.TransactionClient;
const scope = (context: ProviderOperationContext) => ({ organizationId: context.organizationId, tenantId: context.tenantId });

export class PrismaLocalIdentityStore implements LocalIdentityStore {
  async assertLocalConnection(context: ProviderOperationContext): Promise<void> {
    await withTenantDb(scope(context), async (tx) => {
      const connection = await tx.providerConnection.findFirst({ where: {
        id: context.providerConnectionId, organizationId: context.organizationId, providerType: "LUXIA_LOCAL",
      }, select: { id: true } });
      if (!connection) throw new ProviderAdapterError({ code: "INVALID_SCOPE", message: "Local provider connection is outside the requested scope" });
    });
  }

  async createIdentity(context: ProviderOperationContext, input: { subjectId: string; displayName: string; principalName: string; externalObjectId: string }): Promise<LocalIdentityRecord> {
    return withTenantDb(scope(context), async (tx) => {
      const subject = await tx.subject.findFirst({ where: { id: input.subjectId, organizationId: context.organizationId, tenantId: context.tenantId } });
      if (!subject) throw new ProviderAdapterError({ code: "NOT_FOUND", message: "Canonical subject not found in tenant scope" });
      const account = await tx.identityAccount.create({ data: {
        organizationId: context.organizationId, tenantId: context.tenantId, subjectId: subject.id,
        providerConnectionId: context.providerConnectionId, externalObjectId: input.externalObjectId,
      } });
      const local = await tx.localIdentity.create({ data: {
        organizationId: context.organizationId, tenantId: context.tenantId,
        identityAccountId: account.id, principalName: input.principalName,
      } });
      return { identityAccountId: account.id, subjectId: subject.id, externalObjectId: account.externalObjectId,
        displayName: input.displayName || subject.name, principalName: local.principalName,
        status: local.status, failedAttempts: local.failedAttempts,
        lockedUntil: local.lockedUntil?.toISOString() };
    });
  }

  getIdentity(context: ProviderOperationContext, externalObjectId: string): Promise<LocalIdentityRecord | null> {
    return withTenantDb(scope(context), (tx) => this.find(tx, context, { externalObjectId }));
  }
  findIdentityByPrincipal(context: ProviderOperationContext, principalName: string): Promise<LocalIdentityRecord | null> {
    return withTenantDb(scope(context), (tx) => this.find(tx, context, { principalName }));
  }
  listIdentities(context: ProviderOperationContext): Promise<ReadonlyArray<LocalIdentityRecord>> {
    return withTenantDb(scope(context), async (tx) => {
      const rows = await tx.localIdentity.findMany({ where: { organizationId: context.organizationId, tenantId: context.tenantId },
        include: { identityAccount: { include: { subject: true } } } });
      return rows.map((row) => this.map(row));
    });
  }
  async disableIdentity(context: ProviderOperationContext, externalObjectId: string): Promise<LocalIdentityRecord> {
    return withTenantDb(scope(context), async (tx) => {
      const found = await this.find(tx, context, { externalObjectId });
      if (!found) throw new ProviderAdapterError({ code: "NOT_FOUND", message: "Local identity not found" });
      await tx.localIdentity.updateMany({ where: { organizationId: context.organizationId, tenantId: context.tenantId, identityAccountId: found.identityAccountId }, data: { status: "DISABLED" } });
      await tx.localAuthenticator.updateMany({ where: { organizationId: context.organizationId, tenantId: context.tenantId, identityAccountId: found.identityAccountId }, data: { status: "REVOKED", revokedAt: new Date(), stateVersion: { increment: 1 } } });
      await tx.session.updateMany({ where: { organizationId: context.organizationId, tenantId: context.tenantId, identityAccountId: found.identityAccountId, revokedAt: null }, data: { revokedAt: new Date() } });
      return { ...found, status: "DISABLED" };
    });
  }
  listAuthenticators(context: ProviderOperationContext, identityAccountId: string): Promise<ReadonlyArray<LocalAuthenticatorRecord>> {
    return withTenantDb(scope(context), async (tx) => (await tx.localAuthenticator.findMany({ where: {
      organizationId: context.organizationId, tenantId: context.tenantId, identityAccountId,
    } })).map((row) => ({ id: row.id, identityAccountId: row.identityAccountId, type: row.type, status: row.status,
      credentialSchemaVersion: row.credentialSchemaVersion, credentialFormat: row.credentialFormat,
      credentialFormatVersion: row.credentialFormatVersion, algorithmId: row.algorithmId,
      algorithmVersion: row.algorithmVersion, keyId: row.keyId ?? undefined,
      keyVersion: row.keyVersion ?? undefined, trustAnchorId: row.trustAnchorId ?? undefined,
      trustAnchorVersion: row.trustAnchorVersion ?? undefined, verifierPolicyVersion: row.verifierPolicyVersion,
      hardwareBound: row.hardwareBound, deviceSubjectId: row.deviceSubjectId ?? undefined,
      userVerificationRequired: row.userVerificationRequired,
      credentialId: row.credentialId ?? undefined, publicKey: row.publicKey ?? undefined,
      secretRef: row.secretRef ? { key: row.secretRef, version: row.secretVersion ?? undefined } : undefined, relyingPartyId: row.relyingPartyId ?? undefined,
      allowedOrigin: row.allowedOrigin ?? undefined, signCount: Number(row.signCount),
      lastTotpStep: row.lastTotpStep === null ? undefined : Number(row.lastTotpStep), expiresAt: row.expiresAt?.toISOString() })));
  }
  async saveAuthenticator(context: ProviderOperationContext, value: LocalAuthenticatorRecord): Promise<void> {
    await withTenantDb(scope(context), async (tx) => { await tx.localAuthenticator.create({ data: {
      id: value.id, organizationId: context.organizationId, tenantId: context.tenantId, identityAccountId: value.identityAccountId,
      type: value.type, status: value.status, credentialId: value.credentialId, publicKey: value.publicKey,
      credentialSchemaVersion: value.credentialSchemaVersion, credentialFormat: value.credentialFormat,
      credentialFormatVersion: value.credentialFormatVersion, algorithmId: value.algorithmId,
      algorithmVersion: value.algorithmVersion, keyId: value.keyId, keyVersion: value.keyVersion,
      trustAnchorId: value.trustAnchorId, trustAnchorVersion: value.trustAnchorVersion,
      verifierPolicyVersion: value.verifierPolicyVersion, hardwareBound: value.hardwareBound,
      deviceSubjectId: value.deviceSubjectId, userVerificationRequired: value.userVerificationRequired,
      secretRef: value.secretRef?.key, secretVersion: value.secretRef?.version, relyingPartyId: value.relyingPartyId, allowedOrigin: value.allowedOrigin,
      signCount: value.signCount, lastTotpStep: value.lastTotpStep,
      expiresAt: value.expiresAt ? new Date(value.expiresAt) : undefined,
    } }); });
  }
  async revokeAuthenticator(context: ProviderOperationContext, id: string): Promise<void> {
    await withTenantDb(scope(context), async (tx) => { const result = await tx.localAuthenticator.updateMany({ where: {
      id, organizationId: context.organizationId, tenantId: context.tenantId, status: "ACTIVE",
    }, data: { status: "REVOKED", revokedAt: new Date(), stateVersion: { increment: 1 } } }); if (result.count !== 1) throw new ProviderAdapterError({ code: "NOT_FOUND", message: "Local authenticator not found" }); });
  }
  async saveChallenge(context: ProviderOperationContext, value: LocalChallengeRecord): Promise<void> {
    await withTenantDb(scope(context), async (tx) => { await tx.localAuthChallenge.create({ data: {
      id: value.id, organizationId: context.organizationId, tenantId: context.tenantId,
      identityAccountId: value.identityAccountId, purpose: value.purpose, challengeHash: value.challengeHash,
      expiresAt: value.expiresAt, attempts: value.attempts, maxAttempts: value.maxAttempts,
    } }); });
  }
  getChallenge(context: ProviderOperationContext, id: string): Promise<LocalChallengeRecord | null> {
    return withTenantDb(scope(context), async (tx) => { const row = await tx.localAuthChallenge.findFirst({ where: { id, organizationId: context.organizationId, tenantId: context.tenantId } });
      return row ? { id: row.id, identityAccountId: row.identityAccountId, purpose: row.purpose, challengeHash: row.challengeHash,
        expiresAt: row.expiresAt.toISOString(), usedAt: row.usedAt?.toISOString(), attempts: row.attempts, maxAttempts: row.maxAttempts } : null; });
  }
  async consumeChallenge(context: ProviderOperationContext, id: string, now: string): Promise<boolean> {
    return withTenantDb(scope(context), async (tx) => (await tx.localAuthChallenge.updateMany({ where: {
      id, organizationId: context.organizationId, tenantId: context.tenantId, usedAt: null, expiresAt: { gt: new Date(now) },
    }, data: { usedAt: new Date(now) } })).count === 1);
  }
  async recordChallengeFailure(context: ProviderOperationContext, id: string): Promise<void> {
    await withTenantDb(scope(context), async (tx) => { await tx.localAuthChallenge.updateMany({ where: {
      id, organizationId: context.organizationId, tenantId: context.tenantId, usedAt: null,
    }, data: { attempts: { increment: 1 } } }); });
  }
  async recordFailure(context: ProviderOperationContext, identityAccountId: string, lockedUntil?: string): Promise<void> {
    await withTenantDb(scope(context), async (tx) => { await tx.localIdentity.updateMany({ where: { organizationId: context.organizationId, tenantId: context.tenantId, identityAccountId },
      data: { failedAttempts: { increment: 1 }, ...(lockedUntil ? { status: "LOCKED" as const, lockedUntil: new Date(lockedUntil) } : {}) } }); });
  }
  async recordSuccess(context: ProviderOperationContext, identityAccountId: string): Promise<void> {
    await withTenantDb(scope(context), async (tx) => { await tx.localIdentity.updateMany({ where: { organizationId: context.organizationId, tenantId: context.tenantId, identityAccountId },
      data: { failedAttempts: 0, lockedUntil: null, status: "ACTIVE" } }); });
  }
  async advanceAuthenticator(context: ProviderOperationContext, id: string, update: { signCount?: number; lastTotpStep?: number }): Promise<boolean> {
    return withTenantDb(scope(context), async (tx) => {
      const monotonic = update.signCount !== undefined && update.signCount > 0 ? { signCount: { lt: update.signCount } } :
        update.lastTotpStep !== undefined ? { OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: update.lastTotpStep } }] } : {};
      return (await tx.localAuthenticator.updateMany({ where: { id, organizationId: context.organizationId, tenantId: context.tenantId, status: "ACTIVE", ...monotonic },
        data: { ...update, lastUsedAt: new Date() } })).count === 1;
    });
  }
  async saveRecoveryCode(context: ProviderOperationContext, input: { identityAccountId: string; codeHash: string; expiresAt?: string }): Promise<void> {
    await withTenantDb(scope(context), async (tx) => { await tx.localRecoveryCode.create({ data: { organizationId: context.organizationId,
      tenantId: context.tenantId, identityAccountId: input.identityAccountId, codeHash: input.codeHash,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined } }); });
  }
  async consumeRecoveryCode(context: ProviderOperationContext, identityAccountId: string, codeHash: string, now: string): Promise<boolean> {
    return withTenantDb(scope(context), async (tx) => (await tx.localRecoveryCode.updateMany({ where: {
      organizationId: context.organizationId, tenantId: context.tenantId, identityAccountId, codeHash, usedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }],
    }, data: { usedAt: new Date(now) } })).count === 1);
  }

  private async find(tx: Tx, context: ProviderOperationContext, where: { externalObjectId?: string; principalName?: string }): Promise<LocalIdentityRecord | null> {
    const row = await tx.localIdentity.findFirst({ where: { organizationId: context.organizationId, tenantId: context.tenantId,
      ...(where.principalName ? { principalName: where.principalName } : {}),
      ...(where.externalObjectId ? { identityAccount: { providerConnectionId: context.providerConnectionId, externalObjectId: where.externalObjectId } } : {}) },
      include: { identityAccount: { include: { subject: true } } } });
    return row ? this.map(row) : null;
  }
  private map(row: any): LocalIdentityRecord {
    return { identityAccountId: row.identityAccountId, subjectId: row.identityAccount.subjectId,
      externalObjectId: row.identityAccount.externalObjectId, displayName: row.identityAccount.subject.name,
      principalName: row.principalName, status: row.status, failedAttempts: row.failedAttempts,
      lockedUntil: row.lockedUntil?.toISOString() };
  }
}
