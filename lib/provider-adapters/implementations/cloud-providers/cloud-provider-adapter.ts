import { createHash } from "node:crypto";
import {
  PROVIDER_ADAPTER_CONTRACT_VERSION, ProviderAdapterError, ProviderIdempotencyConflictError, UnsupportedProviderCapabilityError,
  assertProviderOperationContext, createProviderProjectionEvidence, type CreateIdentityCommand, type DiscoveredIdentity,
  type ExternalIdentityRef, type GrantAccessCommand, type ProviderAdapter, type ProviderCapability, type ProviderGroup,
  type ProviderHealth, type ProviderIdentity, type ProviderOperationContext, type ProviderResource, type ProvisionResult,
  type RevokeAccessCommand, type SecretLease, type SecretResolver, type SyncCursor, type SyncRequest, type SyncResult,
} from "../..";
import { CLOUD_NORMALIZATION_VERSION, normalizeCloudGroup, normalizeCloudIdentity, normalizeCloudResource } from "./normalization";
import { validateCloudProviderConfig } from "./security";
import type { CloudPage, CloudProviderConfig, CloudProviderConfigResolver, CloudProviderGateway, CloudProviderType,
  CloudRawGroup, CloudRawIdentity, CloudRawResource, RetryBackoff } from "./types";

const capabilities = new Set<ProviderCapability>(["DIRECTORY_DISCOVERY", "GROUP_DISCOVERY", "RESOURCE_DISCOVERY", "INCREMENTAL_SYNC"]);
const MAX_PAGES = 10_000;
const realBackoff: RetryBackoff = { wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) };
export interface CloudProjectionCollisionQuarantine { quarantine(context: ProviderOperationContext, collision: Readonly<{
  objectType: "IDENTITY" | "GROUP" | "RESOURCE"; externalObjectId: string; reasonCode: "DUPLICATE_EXTERNAL_ID";
  firstDigest: string; duplicateDigest: string }>): Promise<void>; }

export class CloudProviderAdapter implements ProviderAdapter {
  readonly contractVersion = PROVIDER_ADAPTER_CONTRACT_VERSION;
  private readonly syncResults = new Map<string, Readonly<{ fingerprint: string; result: SyncResult }>>();
  constructor(readonly type: CloudProviderType, private readonly configs: CloudProviderConfigResolver,
    private readonly secrets: SecretResolver, private readonly gateway: CloudProviderGateway,
    private readonly quarantine?: CloudProjectionCollisionQuarantine, private readonly backoff: RetryBackoff = realBackoff) {}
  capabilities(): ReadonlySet<ProviderCapability> { return new Set(capabilities); }

  async *discoverUsers(context: ProviderOperationContext, cursor?: SyncCursor): AsyncIterable<DiscoveredIdentity> {
    this.validate(context, "DIRECTORY_DISCOVERY"); const seen = new Map<string, string>();
    for await (const item of this.items(context, "IDENTITY", cursor)) {
      const identity = normalizeCloudIdentity(this.type, item.raw as CloudRawIdentity, item.scope);
      if (!await this.unique(context, "IDENTITY", identity.ref.externalObjectId, identity, seen)) continue;
      yield Object.freeze({ identity, ...(item.cursor ? { cursor: item.cursor } : {}), evidence: createProviderProjectionEvidence({
        context, providerType: this.type, eventType: "DISCOVERED", identity, normalizationVersion: CLOUD_NORMALIZATION_VERSION,
        occurredAt: identity.observedAt }) });
    }
  }
  async getUser(context: ProviderOperationContext, ref: ExternalIdentityRef): Promise<ProviderIdentity | null> {
    this.validate(context, "DIRECTORY_DISCOVERY"); requiredExternalId(ref.externalObjectId);
    return this.withConnection(context, async (config, credential) => { const raw = await this.retry(config,
      () => this.gateway.getIdentity({ context, config, credential, externalObjectId: ref.externalObjectId, maximumItems: 1 }));
      if (!raw) return null; const normalized = normalizeCloudIdentity(this.type, raw, config.externalScopeId);
      if (normalized.ref.externalObjectId !== ref.externalObjectId) throw collision("EXTERNAL_ID_MISMATCH"); return normalized; });
  }
  createIdentity(context: ProviderOperationContext, command: CreateIdentityCommand): Promise<ProvisionResult> { void command; return this.readOnly(context, "IDENTITY_LIFECYCLE"); }
  disableIdentity(context: ProviderOperationContext, ref: ExternalIdentityRef): Promise<ProvisionResult> { void ref; return this.readOnly(context, "IDENTITY_LIFECYCLE"); }
  async *listGroups(context: ProviderOperationContext, cursor?: SyncCursor): AsyncIterable<ProviderGroup> {
    this.validate(context, "GROUP_DISCOVERY"); const seen = new Map<string, string>();
    for await (const item of this.items(context, "GROUP", cursor)) { const group = normalizeCloudGroup(this.type, item.raw as CloudRawGroup);
      if (await this.unique(context, "GROUP", group.ref.externalGroupId, group, seen)) yield group; }
  }
  async *listResources(context: ProviderOperationContext, cursor?: SyncCursor): AsyncIterable<ProviderResource> {
    this.validate(context, "RESOURCE_DISCOVERY"); const seen = new Map<string, string>();
    for await (const item of this.items(context, "RESOURCE", cursor)) { const resource = normalizeCloudResource(this.type, item.raw as CloudRawResource, item.scope);
      if (await this.unique(context, "RESOURCE", resource.ref.externalResourceId, resource, seen)) yield resource; }
  }
  grantAccess(context: ProviderOperationContext, command: GrantAccessCommand): Promise<ProvisionResult> { void command; return this.readOnly(context, "ACCESS_PROVISIONING"); }
  revokeAccess(context: ProviderOperationContext, command: RevokeAccessCommand): Promise<ProvisionResult> { void command; return this.readOnly(context, "ACCESS_PROVISIONING"); }
  async sync(context: ProviderOperationContext, request: SyncRequest): Promise<SyncResult> {
    this.validate(context, "INCREMENTAL_SYNC"); const fingerprint = JSON.stringify({ cursor: request.cursor ?? null, mode: request.mode,
      maximumItems: request.maximumItems ?? null }); const key = [context.organizationId, context.tenantId, context.providerConnectionId, context.operationId].join("\0");
    const cached = this.syncResults.get(key); if (cached) { if (cached.fingerprint !== fingerprint) throw new ProviderIdempotencyConflictError(context.operationId); return cached.result; }
    let observed = 0; let nextCursor: SyncCursor | undefined = request.cursor; const limit = maximum(request.maximumItems);
    for await (const item of this.items(context, "IDENTITY", request.cursor, limit)) { normalizeCloudIdentity(this.type, item.raw as CloudRawIdentity, item.scope);
      observed += 1; nextCursor = item.cursor; }
    const result: SyncResult = Object.freeze({ operationId: context.operationId, status: "APPLIED", ...(nextCursor ? { nextCursor } : {}),
      observed, created: 0, updated: 0, disabled: 0, conflicts: 0 }); this.syncResults.set(key, { fingerprint, result }); return result;
  }
  async healthCheck(context: ProviderOperationContext): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString(); try { assertProviderOperationContext(context);
      await this.withConnection(context, (config, credential) => this.retry(config, () => this.gateway.health({ context, config, credential, maximumItems: 1 })));
      return { status: "HEALTHY", checkedAt }; } catch (error) { const permanent = error instanceof ProviderAdapterError && !error.retryable;
      return { status: permanent ? "MISCONFIGURED" : "UNAVAILABLE", checkedAt,
        safeMessage: permanent ? error.message : "Cloud provider health check failed" }; }
  }

  private async *items(context: ProviderOperationContext, kind: "IDENTITY" | "GROUP" | "RESOURCE", cursor?: SyncCursor, requestedMaximum?: number) {
    let next = cursor; let total = 0; const limit = maximum(requestedMaximum); const cursors = new Set<string>();
    for (let pages = 0; pages < MAX_PAGES && total < limit; pages += 1) {
      const result = await this.withConnection(context, async (config, credential) => { const request = { context, config, credential,
        cursor: next, maximumItems: Math.min(config.pageSize, limit - total) };
        const page = await this.retry<CloudPage<CloudRawIdentity | CloudRawGroup | CloudRawResource>>(config, async () => {
          if (kind === "IDENTITY") return this.gateway.listIdentities(request);
          if (kind === "GROUP") return this.gateway.listGroups(request);
          return this.gateway.listResources(request);
        }); return { page, scope: config.externalScopeId }; });
      const page = result.page as CloudPage<CloudRawIdentity | CloudRawGroup | CloudRawResource>;
      if (page.items.length > limit - total) throw collision("PAGE_BOUND_EXCEEDED");
      for (const raw of page.items) { total += 1; yield { raw, cursor: page.nextCursor, scope: result.scope }; }
      if (!page.nextCursor) return; const cursorKey = `${page.nextCursor.version}:${page.nextCursor.value}`;
      if (cursors.has(cursorKey) || (next && page.nextCursor.version <= next.version)) throw collision("CURSOR_DID_NOT_ADVANCE");
      cursors.add(cursorKey); next = page.nextCursor;
    }
    if (total < limit) throw collision("PAGE_LIMIT_EXCEEDED");
  }
  private async withConnection<T>(context: ProviderOperationContext, action: (config: CloudProviderConfig, credential: SecretLease) => Promise<T>): Promise<T> {
    const config = await this.configs.resolve(context); validateCloudProviderConfig(config, context, this.type);
    return this.secrets.withSecret(context, config.credential, (credential) => action(config, credential));
  }
  private async retry<T>(config: CloudProviderConfig, operation: () => Promise<T>): Promise<T> {
    let last: unknown; for (let attempt = 0; attempt <= config.maximumRetries; attempt += 1) try { return await operation(); }
    catch (error) { last = error; if (!(error instanceof ProviderAdapterError) || !error.retryable || attempt === config.maximumRetries) break;
      await this.backoff.wait(Math.min(config.initialBackoffMs * (2 ** attempt), 5_000)); }
    if (last instanceof ProviderAdapterError) throw last; throw new ProviderAdapterError({ code: "UNAVAILABLE", message: "Cloud provider unavailable", retryable: true });
  }
  private async unique(context: ProviderOperationContext, objectType: "IDENTITY" | "GROUP" | "RESOURCE", id: string, value: unknown, seen: Map<string, string>) {
    const digest = JSON.stringify(value); const prior = seen.get(id); if (!prior) { seen.set(id, digest); return true; } if (prior === digest) return false;
    await this.quarantine?.quarantine(context, { objectType, externalObjectId: id, firstDigest: safeDigest(prior),
      duplicateDigest: safeDigest(digest), reasonCode: "DUPLICATE_EXTERNAL_ID" }); throw collision("DUPLICATE_EXTERNAL_ID");
  }
  private validate(context: ProviderOperationContext, capability: ProviderCapability) { assertProviderOperationContext(context);
    if (!capabilities.has(capability)) throw new UnsupportedProviderCapabilityError(this.type, capability); }
  private readOnly<T>(context: ProviderOperationContext, capability: ProviderCapability): Promise<T> { assertProviderOperationContext(context);
    return Promise.reject(new UnsupportedProviderCapabilityError(this.type, capability)); }
}
function maximum(value?: number) { const result = value ?? 10_000; if (!Number.isInteger(result) || result < 1 || result > 100_000)
  throw new ProviderAdapterError({ code: "INVALID_REQUEST", message: "maximumItems is outside the safe range" }); return result; }
function requiredExternalId(value: string) { if (!value.trim() || value.length > 512) throw new ProviderAdapterError({ code: "INVALID_REQUEST", message: "External identity ID is invalid" }); }
function collision(reason: string) { return new ProviderAdapterError({ code: "CONFLICT", message: "Cloud provider projection rejected", safeDetails: { reason } }); }
function safeDigest(value: string) { return `sha256:${createHash("sha256").update(value).digest("base64url")}`; }
