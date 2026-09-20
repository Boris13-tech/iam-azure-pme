import { describe, expect, it } from "vitest";
import {
  ProviderAdapterError,
  assertProviderOperationContext,
  type ProviderOperationContext,
} from "../../lib/provider-adapters";
import type { MicrosoftEntraGraphGateway } from "../../lib/provider-adapters/implementations/microsoft-entra/graph-client";
import { MicrosoftEntraAdapter } from "../../lib/provider-adapters/implementations/microsoft-entra/microsoft-entra-adapter";
import type { MicrosoftEntraOidcGateway } from "../../lib/provider-adapters/implementations/microsoft-entra/oidc-client";
import type {
  MicrosoftEntraConnectionConfig,
  MicrosoftEntraConnectionConfigResolver,
  MicrosoftEntraGraphUser,
  MicrosoftEntraVerifiedClaims,
} from "../../lib/provider-adapters/implementations/microsoft-entra/types";
import {
  context,
  defineProviderAdapterContract,
} from "./provider-adapter-contract-kit";

defineProviderAdapterContract("MicrosoftEntraAdapter", {
  createAdapter: () => createHarness().adapter,
  expectedCapabilities: [
    "AUTHENTICATION",
    "IDENTITY_LIFECYCLE",
    "INCREMENTAL_SYNC",
  ],
});

describe("Phase 6B Microsoft Entra parity", () => {
  it("preserves OIDC redirect, PKCE continuation, and verified oid mapping", async () => {
    const { adapter, oidc } = createHarness();
    const operationContext = context("entra-login");
    const challenge = await adapter.beginAuthentication({
      context: operationContext,
      returnTo: "/dashboard",
    });
    expect(challenge).toMatchObject({
      kind: "REDIRECT",
      redirectUrl: "https://login.microsoftonline.com/tenant-a/oauth2/v2.0/authorize",
      transactionId: "state-a",
      continuation: { nonce: "nonce-a", codeVerifier: "verifier-a" },
    });

    const verified = await adapter.completeAuthentication({
      context: { ...operationContext, operationId: "entra-callback" },
      transactionId: "state-a",
      response: {
        currentUrl: "http://localhost:3000/auth/callback?code=code&state=state-a",
        expectedState: "state-a",
        expectedNonce: "nonce-a",
        codeVerifier: "verifier-a",
      },
    });
    expect(verified.identity.externalObjectId).toBe("oid-a");
    expect(verified.attributes).toMatchObject({
      tid: "tenant-a",
      iss: "https://login.microsoftonline.com/tenant-a/v2.0",
    });
    expect(oidc.completed).toHaveLength(1);
  });

  it("fails closed on tenant and issuer mismatch", async () => {
    const tenantMismatch = createHarness({
      tid: "tenant-b",
      iss: "https://login.microsoftonline.com/tenant-b/v2.0",
    }).adapter;
    await expect(complete(tenantMismatch)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      safeDetails: { reason: "TENANT_MISMATCH" },
    });

    const issuerMismatch = createHarness({
      tid: "tenant-a",
      iss: "https://issuer.invalid/tenant-a",
    }).adapter;
    await expect(complete(issuerMismatch)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      safeDetails: { reason: "ISSUER_MISMATCH" },
    });
  });

  it("preserves Graph create, update, disable, list, and sync semantics", async () => {
    const { adapter, graph } = createHarness();
    const createContext = context("entra-create");
    const created = await adapter.createIdentity(createContext, {
      subjectId: "subject-a",
      displayName: "Alice",
      principalName: "alice@example.com",
    });
    expect(created).toMatchObject({
      status: "APPLIED",
      identity: { externalObjectId: "entra:subject-a" },
    });
    expect(JSON.stringify(created)).not.toContain("temporaryPassword");
    expect(graph.created[0].temporaryPassword).toMatch(/^Temp.+1!$/);

    const users = [];
    for await (const user of adapter.discoverUsers({
      ...createContext,
      operationId: "entra-discover",
    })) {
      users.push(user);
    }
    expect(users).toHaveLength(1);

    await adapter.disableIdentity(
      { ...createContext, operationId: "entra-disable" },
      created.identity!,
    );
    expect(graph.updated.at(-1)).toMatchObject({ accountEnabled: false });

    const sync = await adapter.sync(
      { ...createContext, operationId: "entra-sync" },
      { mode: "FULL" },
    );
    expect(sync).toMatchObject({ status: "APPLIED", observed: 1 });
  });

  it("passes complete organization/tenant/connection scope to every gateway", async () => {
    const { adapter, resolver } = createHarness();
    const scoped = context("entra-health");
    await adapter.healthCheck(scoped);
    await adapter.getUser(
      { ...scoped, operationId: "entra-get" },
      { externalObjectId: "missing" },
    );
    expect(resolver.contexts).toEqual([
      scoped,
      { ...scoped, operationId: "entra-get" },
    ]);
  });
});

class FakeConfigResolver implements MicrosoftEntraConnectionConfigResolver {
  readonly contexts: ProviderOperationContext[] = [];

  async resolve(context: ProviderOperationContext): Promise<MicrosoftEntraConnectionConfig> {
    assertProviderOperationContext(context);
    this.contexts.push({ ...context });
    return {
      organizationId: context.organizationId,
      tenantId: context.tenantId,
      providerConnectionId: context.providerConnectionId,
      directoryTenantId: "tenant-a",
      redirectUri: "http://localhost:3000/auth/callback",
      oidcClientId: "oidc-client",
      oidcClientSecret: { key: "TEST_OIDC_SECRET" },
      graphTenantId: "tenant-a",
      graphClientId: "graph-client",
      graphClientSecret: { key: "TEST_GRAPH_SECRET" },
    };
  }
}

class FakeOidcGateway implements MicrosoftEntraOidcGateway {
  readonly completed: unknown[] = [];

  constructor(private readonly claims: MicrosoftEntraVerifiedClaims) {}

  async begin() {
    return {
      authorizationUrl: "https://login.microsoftonline.com/tenant-a/oauth2/v2.0/authorize",
      state: "state-a",
      nonce: "nonce-a",
      codeVerifier: "verifier-a",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async complete(
    _context: ProviderOperationContext,
    _config: MicrosoftEntraConnectionConfig,
    input: unknown,
  ) {
    this.completed.push(input);
    return this.claims;
  }

  async logoutUrl(
    _context: ProviderOperationContext,
    _config: MicrosoftEntraConnectionConfig,
    postLogoutRedirectUri: string,
  ) {
    return `https://login.microsoftonline.com/logout?post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirectUri)}`;
  }
}

class FakeGraphGateway implements MicrosoftEntraGraphGateway {
  readonly created: Array<{ name: string; email: string; temporaryPassword: string }> = [];
  readonly updated: Array<{ accountEnabled?: boolean; name?: string; email?: string }> = [];
  private readonly users = new Map<string, Map<string, MicrosoftEntraGraphUser>>();

  async listUsersRaw(context: ProviderOperationContext) {
    return (await this.listUsers(context)).map((user) => user.raw ?? {});
  }

  async listUsers(context: ProviderOperationContext) {
    return Array.from(this.forScope(context).values());
  }

  async getUser(
    context: ProviderOperationContext,
    _config: MicrosoftEntraConnectionConfig,
    externalObjectId: string,
  ) {
    return this.forScope(context).get(externalObjectId) ?? null;
  }

  async createUser(
    context: ProviderOperationContext,
    _config: MicrosoftEntraConnectionConfig,
    input: { name: string; email: string; temporaryPassword: string },
  ) {
    this.created.push(input);
    const subject = context.operationId.includes("idempotent")
      ? "subject-1"
      : context.operationId.includes("entra-create")
        ? "subject-a"
        : input.email.split("@")[0];
    const id = `entra:${subject}`;
    this.forScope(context).set(id, {
      id,
      displayName: input.name,
      mail: input.email,
      userPrincipalName: input.email,
      accountEnabled: true,
      raw: { id, displayName: input.name, mail: input.email },
    });
    return { id, userPrincipalName: input.email };
  }

  async updateUser(
    context: ProviderOperationContext,
    _config: MicrosoftEntraConnectionConfig,
    externalObjectId: string,
    update: { accountEnabled?: boolean; name?: string; email?: string },
  ) {
    this.updated.push(update);
    const existing = this.forScope(context).get(externalObjectId);
    if (!existing) {
      throw new ProviderAdapterError({ code: "NOT_FOUND", message: "Not found" });
    }
    this.forScope(context).set(externalObjectId, {
      ...existing,
      accountEnabled: update.accountEnabled ?? existing.accountEnabled,
      displayName: update.name ?? existing.displayName,
      mail: update.email ?? existing.mail,
    });
  }

  private forScope(context: ProviderOperationContext) {
    const key = [
      context.organizationId,
      context.tenantId,
      context.providerConnectionId,
    ].join(":");
    let users = this.users.get(key);
    if (!users) {
      users = new Map();
      this.users.set(key, users);
    }
    return users;
  }
}

function createHarness(claims?: Partial<MicrosoftEntraVerifiedClaims>) {
  const resolver = new FakeConfigResolver();
  const oidc = new FakeOidcGateway({
    oid: "oid-a",
    tid: "tenant-a",
    iss: "https://login.microsoftonline.com/tenant-a/v2.0",
    email: "alice@example.com",
    ...claims,
  });
  const graph = new FakeGraphGateway();
  return {
    adapter: new MicrosoftEntraAdapter(resolver, oidc, graph),
    resolver,
    oidc,
    graph,
  };
}

function complete(adapter: MicrosoftEntraAdapter) {
  return adapter.completeAuthentication({
    context: context("complete"),
    transactionId: "state-a",
    response: {
      currentUrl: "http://localhost:3000/auth/callback?code=a&state=state-a",
      expectedState: "state-a",
      expectedNonce: "nonce-a",
      codeVerifier: "verifier-a",
    },
  });
}
