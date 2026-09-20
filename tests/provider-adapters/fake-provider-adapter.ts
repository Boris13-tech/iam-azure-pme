import {
  PROVIDER_ADAPTER_CONTRACT_VERSION,
  ProviderAdapterError,
  ProviderIdempotencyConflictError,
  UnsupportedProviderCapabilityError,
  assertProviderOperationContext,
  type AuthChallenge,
  type AuthenticationProvider,
  type BeginAuthentication,
  type BeginLogout,
  type CompleteAuthentication,
  type CreateIdentityCommand,
  type DiscoveredIdentity,
  type ExternalIdentityRef,
  type GrantAccessCommand,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderGroup,
  type ProviderHealth,
  type ProviderIdentity,
  type ProviderOperationContext,
  type ProviderResource,
  type ProvisionResult,
  type RevokeAccessCommand,
  type SyncCursor,
  type SyncRequest,
  type SyncResult,
  type UpstreamLogout,
  type VerifiedExternalIdentity,
} from "../../lib/provider-adapters";

type FakeMutation = Readonly<{
  fingerprint: string;
  result: ProvisionResult;
}>;

export type FakeProviderCall = Readonly<{
  method: string;
  context: ProviderOperationContext;
}>;

export class FakeProviderAdapter
  implements ProviderAdapter, AuthenticationProvider
{
  readonly type = "FAKE";
  readonly contractVersion = PROVIDER_ADAPTER_CONTRACT_VERSION;

  private readonly enabledCapabilities: ReadonlySet<ProviderCapability>;
  private readonly identities = new Map<string, Map<string, ProviderIdentity>>();
  private readonly groups = new Map<string, ProviderGroup[]>();
  private readonly resources = new Map<string, ProviderResource[]>();
  private readonly mutations = new Map<string, FakeMutation>();
  private readonly challenges = new Map<string, ProviderOperationContext>();
  private readonly recordedCalls: FakeProviderCall[] = [];

  constructor(capabilities: Iterable<ProviderCapability>) {
    this.enabledCapabilities = new Set(capabilities);
  }

  capabilities(): ReadonlySet<ProviderCapability> {
    return new Set(this.enabledCapabilities);
  }

  calls(): ReadonlyArray<FakeProviderCall> {
    return this.recordedCalls.slice();
  }

  seedGroup(context: ProviderOperationContext, group: ProviderGroup): void {
    this.validateAndRecord("seedGroup", context);
    const key = this.scopeKey(context);
    this.groups.set(key, [...(this.groups.get(key) ?? []), group]);
  }

  seedResource(
    context: ProviderOperationContext,
    resource: ProviderResource,
  ): void {
    this.validateAndRecord("seedResource", context);
    const key = this.scopeKey(context);
    this.resources.set(key, [...(this.resources.get(key) ?? []), resource]);
  }

  async *discoverUsers(
    context: ProviderOperationContext,
    _cursor?: SyncCursor,
  ): AsyncIterable<DiscoveredIdentity> {
    this.requireCapability("IDENTITY_LIFECYCLE");
    this.validateAndRecord("discoverUsers", context);
    for (const identity of this.identitiesFor(context).values()) {
      yield { identity };
    }
  }

  async getUser(
    context: ProviderOperationContext,
    ref: ExternalIdentityRef,
  ): Promise<ProviderIdentity | null> {
    this.requireCapability("IDENTITY_LIFECYCLE");
    this.validateAndRecord("getUser", context);
    return this.identitiesFor(context).get(ref.externalObjectId) ?? null;
  }

  async createIdentity(
    context: ProviderOperationContext,
    command: CreateIdentityCommand,
  ): Promise<ProvisionResult> {
    this.requireCapability("IDENTITY_LIFECYCLE");
    this.validateAndRecord("createIdentity", context);
    return this.mutate(context, "createIdentity", command, () => {
      if (!command.subjectId.trim() || !command.displayName.trim()) {
        throw new ProviderAdapterError({
          code: "INVALID_REQUEST",
          message: "subjectId and displayName are required",
        });
      }

      const externalObjectId = `fake:${command.subjectId}`;
      const identity: ProviderIdentity = {
        ref: { externalObjectId },
        displayName: command.displayName,
        principalName: command.principalName,
        status: "ACTIVE",
        attributes: { ...(command.attributes ?? {}) },
        observedAt: new Date().toISOString(),
        version: "1",
      };
      this.identitiesFor(context).set(externalObjectId, identity);
      return {
        operationId: context.operationId,
        status: "APPLIED",
        identity: identity.ref,
        providerVersion: identity.version,
      };
    });
  }

  async disableIdentity(
    context: ProviderOperationContext,
    ref: ExternalIdentityRef,
  ): Promise<ProvisionResult> {
    this.requireCapability("IDENTITY_LIFECYCLE");
    this.validateAndRecord("disableIdentity", context);
    return this.mutate(context, "disableIdentity", ref, () => {
      const existing = this.identitiesFor(context).get(ref.externalObjectId);
      if (!existing) {
        throw new ProviderAdapterError({
          code: "NOT_FOUND",
          message: "Provider identity was not found",
        });
      }
      const nextVersion = String(Number(existing.version ?? "0") + 1);
      this.identitiesFor(context).set(ref.externalObjectId, {
        ...existing,
        status: "DISABLED",
        observedAt: new Date().toISOString(),
        version: nextVersion,
      });
      return {
        operationId: context.operationId,
        status: "APPLIED",
        identity: ref,
        providerVersion: nextVersion,
      };
    });
  }

  async *listGroups(
    context: ProviderOperationContext,
    _cursor?: SyncCursor,
  ): AsyncIterable<ProviderGroup> {
    this.requireCapability("GROUP_DISCOVERY");
    this.validateAndRecord("listGroups", context);
    for (const group of this.groups.get(this.scopeKey(context)) ?? []) {
      yield group;
    }
  }

  async *listResources(
    context: ProviderOperationContext,
    _cursor?: SyncCursor,
  ): AsyncIterable<ProviderResource> {
    this.requireCapability("RESOURCE_DISCOVERY");
    this.validateAndRecord("listResources", context);
    for (const resource of this.resources.get(this.scopeKey(context)) ?? []) {
      yield resource;
    }
  }

  async grantAccess(
    context: ProviderOperationContext,
    command: GrantAccessCommand,
  ): Promise<ProvisionResult> {
    this.requireCapability("ACCESS_PROVISIONING");
    this.validateAndRecord("grantAccess", context);
    return this.mutate(context, "grantAccess", command, () => ({
      operationId: context.operationId,
      status: "APPLIED",
      identity: command.identity,
    }));
  }

  async revokeAccess(
    context: ProviderOperationContext,
    command: RevokeAccessCommand,
  ): Promise<ProvisionResult> {
    this.requireCapability("ACCESS_PROVISIONING");
    this.validateAndRecord("revokeAccess", context);
    return this.mutate(context, "revokeAccess", command, () => ({
      operationId: context.operationId,
      status: "APPLIED",
      identity: command.identity,
    }));
  }

  async sync(
    context: ProviderOperationContext,
    request: SyncRequest,
  ): Promise<SyncResult> {
    this.requireCapability("INCREMENTAL_SYNC");
    this.validateAndRecord("sync", context);
    const observed = this.identitiesFor(context).size;
    return {
      operationId: context.operationId,
      status: "APPLIED",
      nextCursor: {
        value: `${request.mode.toLowerCase()}:${observed}`,
        version: (request.cursor?.version ?? 0) + 1,
      },
      observed,
      created: 0,
      updated: 0,
      disabled: 0,
      conflicts: 0,
    };
  }

  async healthCheck(
    context: ProviderOperationContext,
  ): Promise<ProviderHealth> {
    this.validateAndRecord("healthCheck", context);
    return { status: "HEALTHY", checkedAt: new Date().toISOString() };
  }

  async beginAuthentication(
    request: BeginAuthentication,
  ): Promise<AuthChallenge> {
    this.requireCapability("AUTHENTICATION");
    this.validateAndRecord("beginAuthentication", request.context);
    const transactionId = `fake-auth:${request.context.operationId}`;
    this.challenges.set(transactionId, request.context);
    return {
      transactionId,
      kind: "LOCAL_CHALLENGE",
      publicChallenge: { nonce: `nonce:${request.context.operationId}` },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async completeAuthentication(
    request: CompleteAuthentication,
  ): Promise<VerifiedExternalIdentity> {
    this.requireCapability("AUTHENTICATION");
    this.validateAndRecord("completeAuthentication", request.context);
    const original = this.challenges.get(request.transactionId);
    if (!original || this.scopeKey(original) !== this.scopeKey(request.context)) {
      throw new ProviderAdapterError({
        code: "AUTHENTICATION_FAILED",
        message: "Authentication challenge is invalid",
      });
    }
    return {
      identity: {
        externalObjectId: request.response.externalObjectId ?? "fake:authenticated",
      },
      assuranceLevel: "FAKE_TEST_ONLY",
      authenticatedAt: new Date().toISOString(),
      attributes: {},
    };
  }

  async beginLogout(request: BeginLogout): Promise<UpstreamLogout | null> {
    this.requireCapability("AUTHENTICATION");
    this.validateAndRecord("beginLogout", request.context);
    return null;
  }

  private validateAndRecord(
    method: string,
    context: ProviderOperationContext,
  ): void {
    assertProviderOperationContext(context);
    this.recordedCalls.push({ method, context: { ...context } });
  }

  private requireCapability(capability: ProviderCapability): void {
    if (!this.enabledCapabilities.has(capability)) {
      throw new UnsupportedProviderCapabilityError(this.type, capability);
    }
  }

  private scopeKey(context: ProviderOperationContext): string {
    return [
      context.organizationId,
      context.tenantId,
      context.providerConnectionId,
    ].join("\u0000");
  }

  private identitiesFor(
    context: ProviderOperationContext,
  ): Map<string, ProviderIdentity> {
    const key = this.scopeKey(context);
    let identities = this.identities.get(key);
    if (!identities) {
      identities = new Map();
      this.identities.set(key, identities);
    }
    return identities;
  }

  private mutate<TCommand>(
    context: ProviderOperationContext,
    method: string,
    command: TCommand,
    action: () => ProvisionResult,
  ): ProvisionResult {
    const key = `${this.scopeKey(context)}\u0000${context.operationId}`;
    const fingerprint = stableSerialize({ method, command });
    const existing = this.mutations.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ProviderIdempotencyConflictError(context.operationId);
      }
      return existing.result;
    }

    const result = Object.freeze(action());
    this.mutations.set(key, { fingerprint, result });
    return result;
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
