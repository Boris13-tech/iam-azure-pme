import {
  PROVIDER_ADAPTER_CONTRACT_VERSION, ProviderAdapterError, UnsupportedProviderCapabilityError, assertProviderOperationContext,
  type CreateIdentityCommand, type DiscoveredIdentity, type ExternalIdentityRef, type GrantAccessCommand, type ProviderAdapter,
  type ProviderCapability, type ProviderGroup, type ProviderHealth, type ProviderIdentity, type ProviderOperationContext,
  ProviderIdempotencyConflictError, type ProviderResource, type ProvisionResult, type RevokeAccessCommand, type SecretResolver, type SyncCursor, type SyncRequest, type SyncResult,
} from "../..";
import { directoryProjectionFingerprint, normalizeDirectoryGroup, normalizeDirectoryIdentity } from "./normalization";
import { escapeLdapFilterValue, validateDirectoryConfig } from "./security";
import type { DirectoryPage, EnterpriseDirectoryConfig, EnterpriseDirectoryConfigResolver, EnterpriseDirectoryGateway, EnterpriseDirectoryType } from "./types";

const capabilities = new Set<ProviderCapability>(["DIRECTORY_DISCOVERY", "GROUP_DISCOVERY", "INCREMENTAL_SYNC"]);
const MAX_PAGES = 10_000;

export interface DirectoryCollisionQuarantine {
  quarantine(context: ProviderOperationContext, collision: Readonly<{ objectType: "IDENTITY" | "GROUP"; externalObjectId: string;
    firstDn: string; duplicateDn: string; reasonCode: "DUPLICATE_EXTERNAL_ID" }>): Promise<void>;
}

export class EnterpriseDirectoryAdapter implements ProviderAdapter {
  readonly contractVersion = PROVIDER_ADAPTER_CONTRACT_VERSION;
  private readonly syncResults = new Map<string, Readonly<{ fingerprint: string; result: SyncResult }>>();
  constructor(readonly type: EnterpriseDirectoryType, private readonly configs: EnterpriseDirectoryConfigResolver,
    private readonly secrets: SecretResolver, private readonly gateway: EnterpriseDirectoryGateway,
    private readonly quarantine?: DirectoryCollisionQuarantine) {}
  capabilities(): ReadonlySet<ProviderCapability> { return new Set(capabilities); }

  async *discoverUsers(context: ProviderOperationContext, cursor?: SyncCursor): AsyncIterable<DiscoveredIdentity> {
    this.validate(context, "DIRECTORY_DISCOVERY"); const seen = new Map<string, string>();
    for await (const item of this.pages(context, "users", cursor)) {
      const normalized = normalizeDirectoryIdentity(this.type, item.entry);
      if (!await this.acceptUnique(context, "IDENTITY", normalized.externalObjectId, normalized.distinguishedName, seen)) continue;
      yield { identity: this.identity(normalized), ...(item.cursor ? { cursor: item.cursor } : {}) };
    }
  }
  async getUser(context: ProviderOperationContext, ref: ExternalIdentityRef): Promise<ProviderIdentity | null> {
    this.validate(context, "DIRECTORY_DISCOVERY"); const escapedExternalId = escapeLdapFilterValue(ref.externalObjectId);
    return this.withConnection(context, async (config, bindSecret) => {
      const raw = await this.retry(config, () => this.gateway.getUser({ context, config, bindSecret, escapedExternalId,
        maximumItems: 1 }));
      if (!raw) return null; const normalized = normalizeDirectoryIdentity(this.type, raw);
      if (normalized.externalObjectId !== ref.externalObjectId.toLowerCase())
        throw new ProviderAdapterError({ code: "CONFLICT", message: "Directory returned an ambiguous identity mapping",
          safeDetails: { reason: "EXTERNAL_ID_MISMATCH" } });
      return this.identity(normalized);
    });
  }
  createIdentity(context: ProviderOperationContext, _command: CreateIdentityCommand): Promise<ProvisionResult> {
    void _command;
    return this.readOnly(context, "IDENTITY_LIFECYCLE");
  }
  disableIdentity(context: ProviderOperationContext, _ref: ExternalIdentityRef): Promise<ProvisionResult> {
    void _ref;
    return this.readOnly(context, "IDENTITY_LIFECYCLE");
  }
  async *listGroups(context: ProviderOperationContext, cursor?: SyncCursor): AsyncIterable<ProviderGroup> {
    this.validate(context, "GROUP_DISCOVERY"); const seen = new Map<string, string>();
    for await (const item of this.pages(context, "groups", cursor)) {
      const normalized = normalizeDirectoryGroup(this.type, item.entry);
      if (!await this.acceptUnique(context, "GROUP", normalized.externalGroupId, normalized.distinguishedName, seen)) continue;
      yield { ref: { externalGroupId: normalized.externalGroupId }, displayName: normalized.displayName,
        attributes: normalized.attributes, observedAt: new Date().toISOString(), version: normalized.version,
        members: normalized.memberExternalIds.map((externalObjectId) => ({ externalObjectId })) };
    }
  }
  async *listResources(context: ProviderOperationContext): AsyncIterable<ProviderResource> { await this.readOnly(context, "RESOURCE_DISCOVERY"); }
  grantAccess(context: ProviderOperationContext, _command: GrantAccessCommand): Promise<ProvisionResult> { void _command; return this.readOnly(context, "ACCESS_PROVISIONING"); }
  revokeAccess(context: ProviderOperationContext, _command: RevokeAccessCommand): Promise<ProvisionResult> { void _command; return this.readOnly(context, "ACCESS_PROVISIONING"); }
  async sync(context: ProviderOperationContext, request: SyncRequest): Promise<SyncResult> {
    this.validate(context, "INCREMENTAL_SYNC"); const fingerprint = JSON.stringify({ cursor: request.cursor ?? null,
      mode: request.mode, maximumItems: request.maximumItems ?? null }); const key = [context.organizationId, context.tenantId,
      context.providerConnectionId, context.operationId].join("\0"); const cached = this.syncResults.get(key);
    if (cached) { if (cached.fingerprint !== fingerprint) throw new ProviderIdempotencyConflictError(context.operationId); return cached.result; }
    const limit = validateMaximumItems(request.maximumItems); let observed = 0; let nextCursor = request.cursor;
    for await (const item of this.pages(context, "users", request.cursor, limit)) { observed += 1; nextCursor = item.cursor; }
    const result: SyncResult = Object.freeze({ operationId: context.operationId, status: "APPLIED", ...(nextCursor ? { nextCursor } : {}),
      observed, created: 0, updated: 0, disabled: 0, conflicts: 0 });
    this.syncResults.set(key, { fingerprint, result }); return result;
  }
  async healthCheck(context: ProviderOperationContext): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try { assertProviderOperationContext(context); await this.withConnection(context, async (config, bindSecret) =>
      this.retry(config, () => this.gateway.health({ context, config, bindSecret, maximumItems: 1 }))); return { status: "HEALTHY", checkedAt }; }
    catch (error) { const permanent = error instanceof ProviderAdapterError && !error.retryable;
      return { status: permanent ? "MISCONFIGURED" : "UNAVAILABLE", checkedAt,
        safeMessage: permanent ? error.message : "Enterprise directory health check failed" }; }
  }

  private async *pages(context: ProviderOperationContext, kind: "users" | "groups", cursor?: SyncCursor, maximumItems?: number) {
    let next = cursor; let total = 0; const limit = validateMaximumItems(maximumItems); const cursors = new Set<string>();
    for (let pageCount = 0; pageCount < MAX_PAGES && total < limit; pageCount += 1) {
      const page: DirectoryPage = await this.withConnection(context, async (config, bindSecret) => this.retry(config, () =>
        kind === "users" ? this.gateway.listUsers({ context, config, bindSecret, cursor: next, maximumItems: Math.min(config.pageSize, limit - total) }) :
          this.gateway.listGroups({ context, config, bindSecret, cursor: next, maximumItems: Math.min(config.pageSize, limit - total) })));
      if (page.entries.length > limit - total) throw new ProviderAdapterError({ code: "CONFLICT", message: "Directory page exceeded requested bound" });
      for (const entry of page.entries) { total += 1; yield { entry, cursor: page.nextCursor }; }
      if (!page.nextCursor) return;
      const cursorKey = `${page.nextCursor.version}:${page.nextCursor.value}`;
      if (cursors.has(cursorKey) || (next && page.nextCursor.version <= next.version))
        throw new ProviderAdapterError({ code: "CONFLICT", message: "Directory pagination cursor did not advance" });
      cursors.add(cursorKey); next = page.nextCursor;
    }
    if (total < limit) throw new ProviderAdapterError({ code: "CONFLICT", message: "Directory pagination exceeded safety limit" });
  }
  private async withConnection<T>(context: ProviderOperationContext,
    action: (config: EnterpriseDirectoryConfig, bindSecret: import("../..").SecretLease) => Promise<T>): Promise<T> {
    const config = await this.configs.resolve(context); validateDirectoryConfig(config, { ...context, type: this.type });
    return this.secrets.withSecret(context, config.bindSecret, (lease) => action(config, lease));
  }
  private async retry<T>(config: EnterpriseDirectoryConfig, operation: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt <= config.maximumRetries; attempt += 1) try { return await operation(); }
    catch (error) { last = error; if (!(error instanceof ProviderAdapterError) || !error.retryable || attempt === config.maximumRetries) break; }
    if (last instanceof ProviderAdapterError) throw last;
    throw new ProviderAdapterError({ code: "UNAVAILABLE", message: "Enterprise directory operation unavailable", retryable: true });
  }
  private identity(value: ReturnType<typeof normalizeDirectoryIdentity>): ProviderIdentity { return Object.freeze({
    ref: { externalObjectId: value.externalObjectId }, displayName: value.displayName, principalName: value.principalName,
    status: value.status, attributes: { ...value.attributes, distinguishedName: value.distinguishedName,
      projectionDigest: directoryProjectionFingerprint(value) }, observedAt: new Date().toISOString(), version: value.version }); }
  private async acceptUnique(context: ProviderOperationContext, objectType: "IDENTITY" | "GROUP", id: string, dn: string, seen: Map<string, string>): Promise<boolean> {
    const prior = seen.get(id); if (!prior) { seen.set(id, dn); return true; } if (prior === dn) return false;
    await this.quarantine?.quarantine(context, { objectType, externalObjectId: id, firstDn: prior, duplicateDn: dn, reasonCode: "DUPLICATE_EXTERNAL_ID" });
    throw new ProviderAdapterError({ code: "CONFLICT", message: "Duplicate directory immutable identifier was quarantined",
      safeDetails: { reason: "DUPLICATE_EXTERNAL_ID" } });
  }
  private validate(context: ProviderOperationContext, capability: ProviderCapability): void {
    assertProviderOperationContext(context); if (!capabilities.has(capability)) throw new UnsupportedProviderCapabilityError(this.type, capability);
  }
  private readOnly<T>(context: ProviderOperationContext, capability: ProviderCapability): Promise<T> {
    assertProviderOperationContext(context); return Promise.reject(new UnsupportedProviderCapabilityError(this.type, capability));
  }
}

function validateMaximumItems(value?: number): number {
  const result = value ?? 10_000; if (!Number.isInteger(result) || result < 1 || result > 100_000)
    throw new ProviderAdapterError({ code: "INVALID_REQUEST", message: "maximumItems is outside the safe range" }); return result;
}
