import { SecretLease, type ProviderOperationContext, type SecretReference, type SecretResolver } from "../../lib/provider-adapters";
import type { LocalAuthenticatorRecord, LocalChallengeRecord, LocalIdentityRecord, LocalIdentityStore } from "../../lib/provider-adapters/implementations/luxia-local";

const sk = (c: ProviderOperationContext) => `${c.organizationId}\0${c.tenantId}\0${c.providerConnectionId}`;
export class MemoryLocalStore implements LocalIdentityStore {
  identities = new Map<string, LocalIdentityRecord>(); authenticators = new Map<string, LocalAuthenticatorRecord>();
  challenges = new Map<string, LocalChallengeRecord>(); recovery = new Map<string, { identityAccountId: string; used: boolean; expiresAt?: string }>();
  async assertLocalConnection(c: ProviderOperationContext) { if (c.providerConnectionId !== "provider-connection-a") throw new Error("invalid local connection"); }
  async createIdentity(c: ProviderOperationContext, i: { subjectId: string; displayName: string; principalName: string; externalObjectId: string }) {
    const value: LocalIdentityRecord = { ...i, identityAccountId: `account-${i.externalObjectId}`, status: "ACTIVE", failedAttempts: 0 };
    this.identities.set(`${sk(c)}\0${i.externalObjectId}`, value); return value;
  }
  async getIdentity(c: ProviderOperationContext, id: string) { return this.identities.get(`${sk(c)}\0${id}`) ?? null; }
  async findIdentityByPrincipal(c: ProviderOperationContext, name: string) { return [...this.identities.entries()].find(([key, value]) => key.startsWith(`${sk(c)}\0`) && value.principalName === name)?.[1] ?? null; }
  async listIdentities(c: ProviderOperationContext) { return [...this.identities.entries()].filter(([key]) => key.startsWith(`${sk(c)}\0`)).map(([, value]) => value); }
  async disableIdentity(c: ProviderOperationContext, id: string) { const value = await this.getIdentity(c, id); if (!value) throw new Error("not found"); const next = { ...value, status: "DISABLED" as const }; this.identities.set(`${sk(c)}\0${id}`, next); return next; }
  async listAuthenticators(c: ProviderOperationContext, account: string) { return [...this.authenticators.entries()].filter(([key, value]) => key.startsWith(`${sk(c)}\0`) && value.identityAccountId === account).map(([, value]) => value); }
  async saveAuthenticator(c: ProviderOperationContext, value: LocalAuthenticatorRecord) { this.authenticators.set(`${sk(c)}\0${value.id}`, value); }
  async revokeAuthenticator(c: ProviderOperationContext, id: string) { const key = `${sk(c)}\0${id}`; const value = this.authenticators.get(key); if (!value) throw new Error("not found"); this.authenticators.set(key, { ...value, status: "REVOKED" }); }
  async saveChallenge(c: ProviderOperationContext, value: LocalChallengeRecord) { this.challenges.set(`${sk(c)}\0${value.id}`, value); }
  async getChallenge(c: ProviderOperationContext, id: string) { return this.challenges.get(`${sk(c)}\0${id}`) ?? null; }
  async consumeChallenge(c: ProviderOperationContext, id: string, now: string) { const key = `${sk(c)}\0${id}`; const value = this.challenges.get(key); if (!value || value.usedAt || Date.parse(value.expiresAt) <= Date.parse(now)) return false; this.challenges.set(key, { ...value, usedAt: now }); return true; }
  async recordChallengeFailure(c: ProviderOperationContext, id: string) { const key = `${sk(c)}\0${id}`; const value = this.challenges.get(key); if (value) this.challenges.set(key, { ...value, attempts: value.attempts + 1 }); }
  async recordFailure(c: ProviderOperationContext, account: string, lockedUntil?: string) { this.updateIdentity(c, account, (value) => ({ ...value, failedAttempts: value.failedAttempts + 1, ...(lockedUntil ? { status: "LOCKED" as const, lockedUntil } : {}) })); }
  async recordSuccess(c: ProviderOperationContext, account: string) { this.updateIdentity(c, account, (value) => ({ ...value, failedAttempts: 0, status: "ACTIVE", lockedUntil: undefined })); }
  async advanceAuthenticator(c: ProviderOperationContext, id: string, update: { signCount?: number; lastTotpStep?: number }) { const key = `${sk(c)}\0${id}`; const value = this.authenticators.get(key); if (!value || value.status !== "ACTIVE") return false; if (update.signCount && update.signCount <= value.signCount) return false; if (update.lastTotpStep !== undefined && value.lastTotpStep !== undefined && update.lastTotpStep <= value.lastTotpStep) return false; this.authenticators.set(key, { ...value, ...update }); return true; }
  async saveRecoveryCode(c: ProviderOperationContext, i: { identityAccountId: string; codeHash: string; expiresAt?: string }) { this.recovery.set(`${sk(c)}\0${i.codeHash}`, { identityAccountId: i.identityAccountId, used: false, expiresAt: i.expiresAt }); }
  async consumeRecoveryCode(c: ProviderOperationContext, account: string, codeHash: string, now: string) { const key = `${sk(c)}\0${codeHash}`; const value = this.recovery.get(key); if (!value || value.identityAccountId !== account || value.used || (value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(now))) return false; this.recovery.set(key, { ...value, used: true }); return true; }
  private updateIdentity(c: ProviderOperationContext, account: string, fn: (v: LocalIdentityRecord) => LocalIdentityRecord) { for (const [key, value] of this.identities) if (key.startsWith(`${sk(c)}\0`) && value.identityAccountId === account) this.identities.set(key, fn(value)); }
}

export class MemorySecrets implements SecretResolver {
  constructor(private readonly values = new Map<string, Uint8Array>()) {}
  set(key: string, value: Uint8Array) { this.values.set(key, value.slice()); }
  async withSecret<T>(_c: ProviderOperationContext, ref: SecretReference, consumer: (secret: SecretLease) => Promise<T>): Promise<T> { const value = this.values.get(ref.key); if (!value) throw new Error("secret unavailable"); const lease = new SecretLease(value); try { return await consumer(lease); } finally { lease.dispose(); } }
}
