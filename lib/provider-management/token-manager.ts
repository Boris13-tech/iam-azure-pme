import { connectionSecretReference, ProviderManagementFailure } from './contracts';

export type ProviderAuthStrategy = 'CLIENT_CREDENTIALS' | 'SERVICE_ACCOUNT' | 'DOMAIN_WIDE_DELEGATION' | 'OAUTH_REFRESH_TOKEN' | 'WORKLOAD_IDENTITY';
export type TokenContext = Readonly<{
  organizationId: string; tenantId: string; providerConnectionId: string;
  providerType: string; credentialVersion: string; authStrategy: ProviderAuthStrategy;
}>;
export type TokenLease = Readonly<{ accessToken: string; expiresAt: number; credentialVersion: string }>;
export type InvalidationReason = 'MANAGEMENT_DISABLED' | 'CREDENTIAL_ROTATED' | 'CREDENTIAL_REVOKED' |
  'PROVIDER_DELETED' | 'TENANT_SCOPE_REMOVED' | 'CREDENTIAL_FAILURE_CONFIRMED' | 'SECURITY_INVALIDATION';
type Event = 'PROVIDER.TOKEN.ACQUIRE.SUCCESS' | 'PROVIDER.TOKEN.ACQUIRE.FAILURE' |
  'PROVIDER.TOKEN.CACHE.INVALIDATE' | 'PROVIDER.CREDENTIAL.ROTATE' | 'PROVIDER.CREDENTIAL.REVOKE';
export interface TokenManagerDependencies {
  // MUST read and validate Organization, Tenant, scoped connection, enabled and
  // exact reference, in that order, BEFORE the acquirer may access custody.
  authorize(context: TokenContext, purpose?: 'ACTIVE' | 'CANDIDATE'): Promise<{ credentialSecretRef: string }>;
  acquire(context: TokenContext, reference: string): Promise<{ accessToken: string; expiresIn: number }>;
  audit(context: TokenContext, event: Event, metadata: Readonly<Record<string, string>>): Promise<void>;
  // Compare-and-swap the active reference/version. No credential bytes allowed.
  activateCredential(context: TokenContext, next: TokenContext): Promise<void>;
  testCredential(context: TokenContext, token: TokenLease): Promise<void>;
}

/** Server-only, ephemeral token custody. Never serialize a lease or pass it to logging. */
export class ProviderTokenManager {
  private readonly cache = new Map<string, TokenLease>();
  private readonly flights = new Map<string, Promise<TokenLease>>();
  private readonly generations = new Map<string, number>();
  constructor(private readonly deps: TokenManagerDependencies,
    private readonly now: () => number = Date.now, private readonly safetyMarginMs = 30_000) {
    if (!Number.isFinite(safetyMarginMs) || safetyMarginMs < 0) throw new Error('INVALID_TOKEN_POLICY');
  }
  private base(c: TokenContext) {
    if ([c.organizationId,c.tenantId,c.providerConnectionId,c.providerType,c.credentialVersion].some(v => !v || v.length > 256))
      throw new ProviderManagementFailure('PROVIDER_TOKEN_CONTEXT_INVALID');
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(c.providerType) ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(c.credentialVersion) ||
      !['CLIENT_CREDENTIALS','SERVICE_ACCOUNT','DOMAIN_WIDE_DELEGATION','OAUTH_REFRESH_TOKEN','WORKLOAD_IDENTITY'].includes(c.authStrategy))
      throw new ProviderManagementFailure('PROVIDER_TOKEN_CONTEXT_INVALID');
    return JSON.stringify([c.organizationId,c.tenantId,c.providerConnectionId,c.providerType]);
  }
  private key(c: TokenContext) { return JSON.stringify([this.base(c),c.credentialVersion,c.authStrategy]); }
  private metadata(c: TokenContext, extra: Record<string,string> = {}) {
    return { providerConnectionId:c.providerConnectionId, providerType:c.providerType,
      credentialVersion:c.credentialVersion, authStrategy:c.authStrategy, ...extra };
  }
  private async scope(c: TokenContext, purpose: 'ACTIVE' | 'CANDIDATE' = 'ACTIVE') {
    this.base(c);
    try {
      const scope = await this.deps.authorize(c,purpose);
      if (scope.credentialSecretRef !== connectionSecretReference(c))
        throw new ProviderManagementFailure('PROVIDER_SECRET_SCOPE_MISMATCH');
      return scope;
    } catch { throw new ProviderManagementFailure('PROVIDER_TOKEN_SCOPE_DENIED'); }
  }
  async getValidToken(context: TokenContext): Promise<TokenLease> {
    const c = Object.freeze({...context});
    await this.scope(c); // A cache HIT does not bypass revoked/disabled/tenant checks.
    const cached = this.cache.get(this.key(c));
    if (cached && cached.expiresAt > this.now() + this.safetyMarginMs) return cached;
    return this.acquire(c);
  }
  async acquire(context: TokenContext): Promise<TokenLease> {
    return this.acquireScoped(context,'ACTIVE');
  }
  private async acquireScoped(context: TokenContext, purpose: 'ACTIVE' | 'CANDIDATE'): Promise<TokenLease> {
    const c = Object.freeze({...context});
    const {credentialSecretRef} = await this.scope(c,purpose);
    const key = this.key(c), base = this.base(c);
    const previous = this.flights.get(key);
    if (previous) return previous;
    const generation = this.generations.get(base) ?? 0;
    // Promise microtask defers custody access until the flight is installed.
    const flight = Promise.resolve().then(async () => {
      try {
        const startedAt = this.now();
        const result = await this.deps.acquire(c,credentialSecretRef);
        if (typeof result.accessToken !== 'string' || !result.accessToken ||
          !Number.isFinite(result.expiresIn) || result.expiresIn <= 0 ||
          !Number.isSafeInteger(Math.ceil(result.expiresIn * 1000)))
          throw new Error('INVALID_TOKEN_RESPONSE');
        const lease = Object.freeze({accessToken:result.accessToken,
          expiresAt:startedAt + result.expiresIn * 1000,credentialVersion:c.credentialVersion});
        if (lease.expiresAt <= this.now() + this.safetyMarginMs) throw new Error('TOKEN_TOO_SHORT');
        await this.scope(c,purpose);
        if ((this.generations.get(base) ?? 0) !== generation) throw new Error('TOKEN_INVALIDATED');
        await this.deps.audit(c,'PROVIDER.TOKEN.ACQUIRE.SUCCESS',this.metadata(c));
        if ((this.generations.get(base) ?? 0) !== generation) throw new Error('TOKEN_INVALIDATED');
        this.cache.set(key,lease);
        return lease;
      } catch {
        if ((this.generations.get(base) ?? 0) === generation) this.cache.delete(key);
        try { await this.deps.audit(c,'PROVIDER.TOKEN.ACQUIRE.FAILURE',
          this.metadata(c,{safeErrorCode:'PROVIDER_CREDENTIAL_INVALID'})); }
        catch { throw new ProviderManagementFailure('PROVIDER_TOKEN_AUDIT_UNAVAILABLE'); }
        throw new ProviderManagementFailure('PROVIDER_CREDENTIAL_INVALID');
      } finally { if (this.flights.get(key) === flight) this.flights.delete(key); }
    });
    this.flights.set(key,flight);
    return flight;
  }
  async invalidate(context: TokenContext, reason: InvalidationReason): Promise<void> {
    if (!['MANAGEMENT_DISABLED','CREDENTIAL_ROTATED','CREDENTIAL_REVOKED','PROVIDER_DELETED',
      'TENANT_SCOPE_REMOVED','CREDENTIAL_FAILURE_CONFIRMED','SECURITY_INVALIDATION'].includes(reason))
      throw new ProviderManagementFailure('PROVIDER_TOKEN_CONTEXT_INVALID');
    const c = Object.freeze({...context}), base = this.base(c);
    this.generations.set(base,(this.generations.get(base) ?? 0) + 1);
    // Clear all versions/strategies for this connection, never another tenant.
    for (const key of this.cache.keys()) if (JSON.parse(key)[0] === base) this.cache.delete(key);
    for (const key of this.flights.keys()) if (JSON.parse(key)[0] === base) this.flights.delete(key);
    try {
      await this.deps.audit(c,'PROVIDER.TOKEN.CACHE.INVALIDATE',this.metadata(c,{reason}));
      if (reason === 'CREDENTIAL_REVOKED')
        await this.deps.audit(c,'PROVIDER.CREDENTIAL.REVOKE',this.metadata(c,{reason}));
    } catch {throw new ProviderManagementFailure('PROVIDER_TOKEN_AUDIT_UNAVAILABLE');}
  }
  async rotateCredential(context: TokenContext, newCredentialVersion: string): Promise<void> {
    const c = Object.freeze({...context}), next = Object.freeze({...c,credentialVersion:newCredentialVersion});
    this.base(next);
    if (next.credentialVersion === c.credentialVersion) throw new ProviderManagementFailure('PROVIDER_CREDENTIAL_VERSION_CONFLICT');
    const candidate = await this.acquireScoped(next,'CANDIDATE');
    try {
      await this.deps.testCredential(next,candidate);
      await this.deps.activateCredential(c,next); // Atomic CAS is a custody adapter obligation.
    } catch {
      this.cache.delete(this.key(next));
      throw new ProviderManagementFailure('PROVIDER_CREDENTIAL_ROTATION_FAILED');
    }
    // Once activation succeeds, invalidate immediately even if audit fails.
    await this.invalidate(c,'CREDENTIAL_ROTATED');
    try {await this.deps.audit(next,'PROVIDER.CREDENTIAL.ROTATE',this.metadata(next));}
    catch {throw new ProviderManagementFailure('PROVIDER_TOKEN_AUDIT_UNAVAILABLE');}
  }
  async executeWithToken<T extends {status:number}>(context: TokenContext,
    operation: (token: string) => Promise<T>): Promise<T> {
    const c = Object.freeze({...context});
    const invoke = async (lease: TokenLease) => {
      await this.scope(c);
      if (lease.expiresAt <= this.now() + this.safetyMarginMs) throw new ProviderManagementFailure('PROVIDER_CREDENTIAL_INVALID');
      try { return await operation(lease.accessToken); }
      catch { throw new ProviderManagementFailure('PROVIDER_UNAVAILABLE'); }
    };
    let response = await invoke(await this.getValidToken(c));
    if (response.status === 401) {
      await this.invalidate(c,'CREDENTIAL_FAILURE_CONFIRMED');
      response = await invoke(await this.acquire(c));
      if (response.status === 401) {
        await this.invalidate(c,'CREDENTIAL_FAILURE_CONFIRMED');
        throw new ProviderManagementFailure('PROVIDER_CREDENTIAL_INVALID');
      }
    }
    if (response.status === 403) throw new ProviderManagementFailure('PROVIDER_SCOPE_INSUFFICIENT');
    return response;
  }
}
