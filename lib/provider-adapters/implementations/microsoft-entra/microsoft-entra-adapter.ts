import { randomBytes } from "node:crypto";
import { createAuthenticationEvidence } from "../../../identity";
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
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderGroup,
  type ProviderHealth,
  type ProviderIdentity,
  type ProviderOperationContext,
  type ProviderResource,
  type ProvisionResult,
  type SyncRequest,
  type SyncResult,
  type UpstreamLogout,
  type VerifiedExternalIdentity,
} from "../..";
import type { MicrosoftEntraGraphGateway } from "./graph-client";
import type { MicrosoftEntraOidcGateway } from "./oidc-client";
import {
  MICROSOFT_ENTRA_PROVIDER_TYPE,
  type MicrosoftEntraConnectionConfigResolver,
  type MicrosoftEntraGraphUser,
  type MicrosoftEntraVerifiedClaims,
} from "./types";

const capabilities = new Set<ProviderCapability>([
  "AUTHENTICATION",
  "IDENTITY_LIFECYCLE",
  "INCREMENTAL_SYNC",
]);

type CachedMutation = Readonly<{
  fingerprint: string;
  result: ProvisionResult;
}>;

export class MicrosoftEntraAdapter
  implements ProviderAdapter, AuthenticationProvider
{
  readonly type = MICROSOFT_ENTRA_PROVIDER_TYPE;
  readonly contractVersion = PROVIDER_ADAPTER_CONTRACT_VERSION;
  private readonly mutations = new Map<string, CachedMutation>();

  constructor(
    private readonly connectionConfig: MicrosoftEntraConnectionConfigResolver,
    private readonly oidc: MicrosoftEntraOidcGateway,
    private readonly graph: MicrosoftEntraGraphGateway,
  ) {}

  capabilities(): ReadonlySet<ProviderCapability> {
    return new Set(capabilities);
  }

  async beginAuthentication(
    request: BeginAuthentication,
  ): Promise<AuthChallenge> {
    const context = request.context;
    this.validate(context, "AUTHENTICATION");
    const config = await this.connectionConfig.resolve(context);
    const result = await this.oidc.begin(context, config);
    return {
      transactionId: result.state,
      kind: "REDIRECT",
      redirectUrl: result.authorizationUrl,
      continuation: {
        nonce: result.nonce,
        codeVerifier: result.codeVerifier,
      },
      expiresAt: result.expiresAt,
    };
  }

  async completeAuthentication(
    request: CompleteAuthentication,
  ): Promise<VerifiedExternalIdentity> {
    const context = request.context;
    this.validate(context, "AUTHENTICATION");
    const required = [
      "currentUrl",
      "codeVerifier",
      "expectedState",
      "expectedNonce",
    ] as const;
    for (const field of required) {
      if (!request.response[field]) {
        throw new ProviderAdapterError({
          code: "INVALID_REQUEST",
          message: `Missing authentication response field '${field}'`,
        });
      }
    }
    const config = await this.connectionConfig.resolve(context);
    const claims = await this.oidc.complete(context, config, {
      currentUrl: request.response.currentUrl,
      codeVerifier: request.response.codeVerifier,
      expectedState: request.response.expectedState,
      expectedNonce: request.response.expectedNonce,
    });
    this.validateClaims(config.directoryTenantId, claims);
    const authenticatedAt = new Date().toISOString();
    return {
      identity: { externalObjectId: claims.oid },
      assuranceLevel: "ENTRA_OIDC",
      authenticatedAt,
      attributes: {
        tid: claims.tid,
        iss: claims.iss,
        email: claims.email ?? null,
        preferredUsername: claims.preferredUsername ?? null,
        name: claims.name ?? null,
      },
      evidence: createAuthenticationEvidence({
        organizationId: context.organizationId,
        tenantId: context.tenantId,
        providerConnectionId: context.providerConnectionId,
        externalObjectId: claims.oid,
        method: "FEDERATED_OIDC",
        reasonCode: "ENTRA_OIDC_VERIFIED",
        assurance: {
          level: "LOW",
          profile: "entra-oidc",
          profileVersion: 1,
          phishingResistant: false,
          hardwareBound: false,
          userVerification: "PROVIDER_ASSERTED",
        },
        provenance: {
          schemaVersion: 1,
          source: "EXTERNAL_PROVIDER",
          sourceRef: this.type,
          verifierPolicyVersion: 1,
          operationId: context.operationId,
          occurredAt: authenticatedAt,
          offline: false,
        },
      }),
    };
  }

  async beginLogout(request: BeginLogout): Promise<UpstreamLogout | null> {
    const context = request.context;
    this.validate(context, "AUTHENTICATION");
    if (!request.postLogoutRedirectUri) return null;
    const config = await this.connectionConfig.resolve(context);
    const redirectUrl = await this.oidc.logoutUrl(
      context,
      config,
      request.postLogoutRedirectUri,
    );
    return redirectUrl ? { redirectUrl } : null;
  }

  async *discoverUsers(
    context: ProviderOperationContext,
  ): AsyncIterable<DiscoveredIdentity> {
    this.validate(context, "IDENTITY_LIFECYCLE");
    for (const user of await this.listMicrosoftGraphUsers(context)) {
      yield { identity: this.toProviderIdentity(user) };
    }
  }

  async getUser(
    context: ProviderOperationContext,
    ref: ExternalIdentityRef,
  ): Promise<ProviderIdentity | null> {
    this.validate(context, "IDENTITY_LIFECYCLE");
    const config = await this.connectionConfig.resolve(context);
    const user = await this.graph.getUser(
      context,
      config,
      ref.externalObjectId,
    );
    return user ? this.toProviderIdentity(user) : null;
  }

  async createIdentity(
    context: ProviderOperationContext,
    command: CreateIdentityCommand,
  ): Promise<ProvisionResult> {
    this.validate(context, "IDENTITY_LIFECYCLE");
    const email =
      command.principalName ||
      (typeof command.attributes?.email === "string"
        ? command.attributes.email
        : undefined);
    if (!email) {
      throw new ProviderAdapterError({
        code: "INVALID_REQUEST",
        message: "Microsoft Entra identity creation requires a principal name",
      });
    }
    return this.idempotent(context, "createIdentity", command, async () => {
      const created = await this.createMicrosoftEntraUser(
        context,
        command.displayName,
        email,
      );
      return {
        operationId: context.operationId,
        status: "APPLIED",
        identity: { externalObjectId: created.id },
      };
    });
  }

  async disableIdentity(
    context: ProviderOperationContext,
    ref: ExternalIdentityRef,
  ): Promise<ProvisionResult> {
    this.validate(context, "IDENTITY_LIFECYCLE");
    return this.idempotent(context, "disableIdentity", ref, async () => {
      await this.updateMicrosoftEntraUser(context, ref.externalObjectId, {
        accountEnabled: false,
      });
      return {
        operationId: context.operationId,
        status: "APPLIED",
        identity: ref,
      };
    });
  }

  async *listGroups(
    context: ProviderOperationContext,
  ): AsyncIterable<ProviderGroup> {
    this.validate(context, "GROUP_DISCOVERY");
  }

  async *listResources(
    context: ProviderOperationContext,
  ): AsyncIterable<ProviderResource> {
    this.validate(context, "RESOURCE_DISCOVERY");
  }

  async grantAccess(
    context: ProviderOperationContext,
  ): Promise<ProvisionResult> {
    this.validate(context, "ACCESS_PROVISIONING");
    throw new UnsupportedProviderCapabilityError(
      this.type,
      "ACCESS_PROVISIONING",
    );
  }

  async revokeAccess(
    context: ProviderOperationContext,
  ): Promise<ProvisionResult> {
    this.validate(context, "ACCESS_PROVISIONING");
    throw new UnsupportedProviderCapabilityError(
      this.type,
      "ACCESS_PROVISIONING",
    );
  }

  async sync(
    context: ProviderOperationContext,
    request: SyncRequest,
  ): Promise<SyncResult> {
    this.validate(context, "INCREMENTAL_SYNC");
    const users = await this.listMicrosoftGraphUsers(context);
    return {
      operationId: context.operationId,
      status: "APPLIED",
      nextCursor: {
        value: `${request.mode.toLowerCase()}:${users.length}`,
        version: (request.cursor?.version ?? 0) + 1,
      },
      observed: users.length,
      created: 0,
      updated: 0,
      disabled: 0,
      conflicts: 0,
    };
  }

  async healthCheck(
    context: ProviderOperationContext,
  ): Promise<ProviderHealth> {
    try {
      assertProviderOperationContext(context);
      await this.connectionConfig.resolve(context);
      return { status: "HEALTHY", checkedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ProviderAdapterError && !error.retryable) {
        return {
          status: "MISCONFIGURED",
          checkedAt: new Date().toISOString(),
          safeMessage: error.message,
        };
      }
      return {
        status: "UNAVAILABLE",
        checkedAt: new Date().toISOString(),
        safeMessage: "Microsoft Entra health check failed",
      };
    }
  }

  async listMicrosoftGraphUsers(
    context: ProviderOperationContext,
  ): Promise<MicrosoftEntraGraphUser[]> {
    this.validate(context, "IDENTITY_LIFECYCLE");
    const config = await this.connectionConfig.resolve(context);
    return this.graph.listUsers(context, config);
  }

  async listRawMicrosoftGraphUsers(
    context: ProviderOperationContext,
  ): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
    this.validate(context, "IDENTITY_LIFECYCLE");
    const config = await this.connectionConfig.resolve(context);
    return this.graph.listUsersRaw(context, config);
  }

  async createMicrosoftEntraUser(
    context: ProviderOperationContext,
    name: string,
    email: string,
  ) {
    this.validate(context, "IDENTITY_LIFECYCLE");
    const config = await this.connectionConfig.resolve(context);
    return this.graph.createUser(context, config, {
      name,
      email,
      temporaryPassword: createTemporaryPassword(),
    });
  }

  async updateMicrosoftEntraUser(
    context: ProviderOperationContext,
    externalObjectId: string,
    update: { accountEnabled?: boolean; name?: string; email?: string },
  ): Promise<void> {
    this.validate(context, "IDENTITY_LIFECYCLE");
    const config = await this.connectionConfig.resolve(context);
    await this.graph.updateUser(context, config, externalObjectId, update);
  }

  private validate(
    context: ProviderOperationContext,
    capability: ProviderCapability,
  ): void {
    assertProviderOperationContext(context);
    if (!capabilities.has(capability)) {
      throw new UnsupportedProviderCapabilityError(this.type, capability);
    }
  }

  private validateClaims(
    expectedTenantId: string,
    claims: MicrosoftEntraVerifiedClaims,
  ): void {
    if (claims.tid !== expectedTenantId) {
      throw new ProviderAdapterError({
        code: "AUTHENTICATION_FAILED",
        message: "Microsoft Entra tenant mismatch",
        safeDetails: { reason: "TENANT_MISMATCH" },
      });
    }
    const expectedIssuer = `https://login.microsoftonline.com/${claims.tid}/v2.0`;
    if (claims.iss !== expectedIssuer) {
      throw new ProviderAdapterError({
        code: "AUTHENTICATION_FAILED",
        message: "Microsoft Entra issuer mismatch",
        safeDetails: { reason: "ISSUER_MISMATCH" },
      });
    }
  }

  private toProviderIdentity(user: MicrosoftEntraGraphUser): ProviderIdentity {
    return {
      ref: { externalObjectId: user.id },
      displayName: user.displayName || user.mail || user.userPrincipalName || user.id,
      principalName: user.mail || user.userPrincipalName,
      status: user.accountEnabled === false ? "DISABLED" : "ACTIVE",
      attributes: {
        email: user.mail ?? null,
        userPrincipalName: user.userPrincipalName ?? null,
      },
      observedAt: new Date().toISOString(),
    };
  }

  private async idempotent<TCommand>(
    context: ProviderOperationContext,
    method: string,
    command: TCommand,
    action: () => Promise<ProvisionResult>,
  ): Promise<ProvisionResult> {
    const key = [
      context.organizationId,
      context.tenantId,
      context.providerConnectionId,
      context.operationId,
    ].join("\u0000");
    const fingerprint = stableSerialize({ method, command });
    const cached = this.mutations.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new ProviderIdempotencyConflictError(context.operationId);
      }
      return cached.result;
    }
    const result = Object.freeze(await action());
    this.mutations.set(key, { fingerprint, result });
    return result;
  }
}

function createTemporaryPassword(): string {
  return `Temp${randomBytes(12).toString("base64url")}1!`;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
