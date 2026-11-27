import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAdapterError, type ProviderOperationContext } from "../../lib/provider-adapters";

const mocks = vi.hoisted(() => ({
  tenantFindFirst: vi.fn(),
  connectionFindFirst: vi.fn(),
  connectionFindMany: vi.fn(),
  secretRefFindFirst: vi.fn(),
  headersGet: vi.fn(),
}));

vi.mock("../../lib/db/scoped-client", () => ({
  withTenantDb: vi.fn(async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      tenant: { findFirst: mocks.tenantFindFirst },
      providerConnection: {
        findFirst: mocks.connectionFindFirst,
        findMany: mocks.connectionFindMany,
      },
      providerSecretReference: { findFirst: mocks.secretRefFindFirst },
    }),
  ),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: mocks.headersGet })),
}));

import {
  PrismaMicrosoftEntraConnectionConfigResolver,
  connectionScopedEnvPrefix,
  locateMicrosoftEntraConnection,
} from "../../lib/provider-adapters/implementations/microsoft-entra/connection-config";
import { EnvironmentSecretResolver } from "../../lib/provider-adapters/infrastructure/environment-secret-resolver";
import {
  assertSecretStoreAllowed,
  createRuntimeSecretResolver,
  isProductionRuntime,
  parseSecretReference,
  readPlatformWorkloadAssertion,
} from "../../lib/provider-adapters/infrastructure/secret-stores";

const VERSION = "0123456789abcdef0123456789abcdef";
const CTX_A: ProviderOperationContext = {
  organizationId: "org-a",
  tenantId: "tenant-a",
  providerConnectionId: "conn-a",
  operationId: "op-1",
};

describe("G2-R02 (F-02): Microsoft Entra & Graph per-connection secret isolation and F3 guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenantFindFirst.mockResolvedValue({ id: "tenant-a" });
    mocks.connectionFindFirst.mockResolvedValue({
      id: "conn-a",
      externalScopeId: "11111111-2222-4333-8444-555555555555",
      status: "ACTIVE",
    });
    mocks.secretRefFindFirst.mockResolvedValue(null);
  });

  it("uses a bijective hex prefix with zero collisions across punctuation and casing, within parseSecretReference bounds", () => {
    const candidates = [
      "conn-a",
      "conn_a",
      "Conn-A",
      "CONN_A",
      "conn.a",
      "conn:a",
      "a-b_c",
      "a_b-c",
      "550e8400-e29b-41d4-a716-446655440000",
      "cm9x1234567890abcdefghijk",
    ];
    const prefixes = candidates.map(connectionScopedEnvPrefix);
    expect(new Set(prefixes).size).toBe(candidates.length);

    for (const prefix of prefixes) {
      const secretEnvName = `${prefix}_GRAPH_CLIENT_SECRET`;
      expect(secretEnvName.length).toBeLessThanOrEqual(128);
      expect(parseSecretReference({ key: `env://${secretEnvName}` })).toEqual({
        store: "environment",
        name: secretEnvName,
      });
    }

    expect(() => connectionScopedEnvPrefix("")).toThrowError(ProviderAdapterError);
    expect(() => connectionScopedEnvPrefix("x".repeat(46))).toThrowError(ProviderAdapterError);
  });

  it("Production fails closed: ignores all global and env secrets, requires HTTPS APP_URL, and uses only F3 vault references", async () => {
    const prefixA = connectionScopedEnvPrefix("conn-a");
    const prodEnv: Record<string, string | undefined> = {
      VERCEL_ENV: "production",
      NEXT_PUBLIC_APP_URL: "https://iam-azure-pme.vercel.app",
      // Legacy global variables still lingering in environment must be completely ignored:
      ENTRA_AUTH_CLIENT_ID: "global-oidc-client-id",
      ENTRA_AUTH_CLIENT_SECRET: "global-oidc-secret-must-not-be-used",
      GRAPH_CLIENT_ID: "global-graph-client-id",
      NEXT_PUBLIC_GRAPH_CLIENT_ID: "public-graph-client-id",
      GRAPH_CLIENT_SECRET: "global-graph-secret-must-not-be-used",
      GRAPH_TENANT_ID: "global-graph-tenant",
      NEXT_PUBLIC_GRAPH_TENANT_ID: "public-graph-tenant",
      // Even a connection-scoped env secret must be ignored in Production:
      [`${prefixA}_AUTH_CLIENT_SECRET`]: "scoped-env-secret-forbidden-in-prod",
      [`${prefixA}_GRAPH_CLIENT_SECRET`]: "scoped-graph-env-secret-forbidden-in-prod",
      [`${prefixA}_AUTH_CLIENT_ID`]: "scoped-oidc-client-id",
    };

    const resolver = new PrismaMicrosoftEntraConnectionConfigResolver(() => prodEnv);
    const withoutVaultRow = await resolver.resolve(CTX_A);
    expect(withoutVaultRow.oidcClientId).toBe("scoped-oidc-client-id");
    expect(withoutVaultRow.oidcClientSecret).toBeUndefined();
    expect(withoutVaultRow.graphClientId).toBeUndefined();
    expect(withoutVaultRow.graphClientSecret).toBeUndefined();
    expect(withoutVaultRow.graphTenantId).toBe("11111111-2222-4333-8444-555555555555");
    expect(withoutVaultRow.redirectUri).toBe("https://iam-azure-pme.vercel.app/auth/callback");

    // Once F3 ProviderSecretReference row exists for OIDC_CLIENT, it resolves that exact pinned vault locator.
    mocks.secretRefFindFirst.mockImplementation(async ({ where }: { where: { purpose: string } }) =>
      where.purpose === "OIDC_CLIENT"
        ? { locator: "akv://luxia-app-kv/entra-oidc-conn-a", activeVersion: VERSION, candidateVersion: null }
        : null,
    );
    const withVaultRow = await resolver.resolve(CTX_A);
    expect(withVaultRow.oidcClientSecret).toEqual({
      key: "akv://luxia-app-kv/entra-oidc-conn-a",
      version: VERSION,
    });
    expect(withVaultRow.graphClientSecret).toBeUndefined();

    // Missing or HTTP NEXT_PUBLIC_APP_URL in Production fails closed.
    const noUrlResolver = new PrismaMicrosoftEntraConnectionConfigResolver(() => ({
      VERCEL_ENV: "production",
    }));
    await expect(noUrlResolver.resolve(CTX_A)).rejects.toMatchObject({
      code: "MISCONFIGURED",
      safeDetails: { reason: "APP_URL_MISSING" },
    });

    const httpUrlResolver = new PrismaMicrosoftEntraConnectionConfigResolver(() => ({
      VERCEL_ENV: "production",
      NEXT_PUBLIC_APP_URL: "http://iam-azure-pme.vercel.app",
    }));
    await expect(httpUrlResolver.resolve(CTX_A)).rejects.toMatchObject({
      code: "MISCONFIGURED",
      safeDetails: { reason: "APP_URL_INSECURE" },
    });
  });

  it("isolates connections outside Production too: never falls back to global secrets or colliding neighbour IDs", async () => {
    const prefixUnderscore = connectionScopedEnvPrefix("conn_a");
    const devEnv: Record<string, string | undefined> = {
      NODE_ENV: "test",
      ENTRA_AUTH_CLIENT_ID: "global-client",
      ENTRA_AUTH_CLIENT_SECRET: "global-secret",
      GRAPH_CLIENT_SECRET: "global-graph-secret",
      [`${prefixUnderscore}_AUTH_CLIENT_ID`]: "neighbour-client",
      [`${prefixUnderscore}_AUTH_CLIENT_SECRET`]: "neighbour-secret",
    };

    const resolver = new PrismaMicrosoftEntraConnectionConfigResolver(() => devEnv);
    const resolvedA = await resolver.resolve(CTX_A); // CTX_A is "conn-a", NOT "conn_a"
    expect(resolvedA.oidcClientId).toBeUndefined();
    expect(resolvedA.oidcClientSecret).toBeUndefined();
    expect(resolvedA.graphClientSecret).toBeUndefined();
  });

  it("enforces ACTIVE connection status on both resolve() and locateMicrosoftEntraConnection()", async () => {
    const resolver = new PrismaMicrosoftEntraConnectionConfigResolver(() => ({ NODE_ENV: "test" }));
    for (const status of ["DRAFT", "TESTING", "DISABLED", "QUARANTINED"] as const) {
      mocks.connectionFindFirst.mockResolvedValueOnce({
        id: "conn-a",
        externalScopeId: "11111111-2222-4333-8444-555555555555",
        status,
      });
      await expect(resolver.resolve(CTX_A), status).rejects.toMatchObject({
        code: "INVALID_SCOPE",
        safeDetails: { providerConnectionId: "conn-a", reason: "PROVIDER_CONNECTION_NOT_ACTIVE" },
      });
    }

    mocks.connectionFindMany.mockResolvedValueOnce([]);
    await expect(
      locateMicrosoftEntraConnection({ organizationId: "org-a", tenantId: "tenant-a" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.connectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-a",
          providerType: "MICROSOFT_ENTRA",
          status: "ACTIVE",
        },
      }),
    );
  });

  it("wires assertSecretStoreAllowed across all Production definitions and fails closed without crashing secretless loads", async () => {
    expect(isProductionRuntime({ VERCEL_ENV: "production" })).toBe(true);
    expect(isProductionRuntime({ APP_ENV: "production" })).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe(false);
    expect(isProductionRuntime({ NODE_ENV: "production", APP_ENV: "staging" })).toBe(false);

    expect(() => assertSecretStoreAllowed(new EnvironmentSecretResolver(), { NODE_ENV: "production" })).toThrow(
      "PRODUCTION_SECRET_STORE_REQUIRED",
    );

    // Unconfigured vault in Production: construction succeeds (passkey sign-in unaffected), withSecret fails closed.
    const unconfiguredProd = createRuntimeSecretResolver({ env: { VERCEL_ENV: "production" } });
    expect(unconfiguredProd.kind).toBe("azure-key-vault");
    await expect(
      unconfiguredProd.withSecret(CTX_A, { key: "akv://luxia-app-kv/entra-oidc", version: VERSION }, async () => "never"),
    ).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
      safeDetails: { reason: "VAULT_WORKLOAD_UNCONFIGURED" },
    });

    // Spoofed x-vercel-oidc-token header off Vercel (VERCEL !== "1") is ignored.
    mocks.headersGet.mockReturnValue("spoofed.jwt.token");
    await expect(readPlatformWorkloadAssertion({ NODE_ENV: "production" })).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
      safeDetails: { reason: "WORKLOAD_ASSERTION_UNAVAILABLE" },
    });

    // On Vercel (VERCEL === "1"), platform-injected x-vercel-oidc-token is accepted.
    await expect(readPlatformWorkloadAssertion({ VERCEL: "1", VERCEL_ENV: "production" })).resolves.toBe(
      "spoofed.jwt.token",
    );

    // Non-Production end-to-end check: connection-scoped env:// references emitted by connection-config
    // resolve cleanly through createRuntimeSecretResolver() -> EnvironmentSecretResolver.
    const prefix = connectionScopedEnvPrefix("conn-a");
    const savedOidc = process.env[`${prefix}_AUTH_CLIENT_SECRET`];
    const savedGraph = process.env[`${prefix}_GRAPH_CLIENT_SECRET`];
    try {
      process.env[`${prefix}_AUTH_CLIENT_SECRET`] = "preview-oidc-secret-value";
      process.env[`${prefix}_GRAPH_CLIENT_SECRET`] = "preview-graph-secret-value";
      mocks.connectionFindFirst.mockResolvedValueOnce({
        id: "conn-a",
        externalScopeId: "11111111-2222-4333-8444-555555555555",
        status: "ACTIVE",
      });
      mocks.secretRefFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const cfg = await new PrismaMicrosoftEntraConnectionConfigResolver(() => process.env).resolve(CTX_A);
      const previewResolver = createRuntimeSecretResolver({ env: { VERCEL_ENV: "preview" } });
      const resolvedOidc = await previewResolver.withSecret(CTX_A, cfg.oidcClientSecret!, async (lease) =>
        lease.read((bytes) => new TextDecoder().decode(bytes)),
      );
      const resolvedGraph = await previewResolver.withSecret(CTX_A, cfg.graphClientSecret!, async (lease) =>
        lease.read((bytes) => new TextDecoder().decode(bytes)),
      );
      expect(resolvedOidc).toBe("preview-oidc-secret-value");
      expect(resolvedGraph).toBe("preview-graph-secret-value");
    } finally {
      if (savedOidc === undefined) delete process.env[`${prefix}_AUTH_CLIENT_SECRET`];
      else process.env[`${prefix}_AUTH_CLIENT_SECRET`] = savedOidc;
      if (savedGraph === undefined) delete process.env[`${prefix}_GRAPH_CLIENT_SECRET`];
      else process.env[`${prefix}_GRAPH_CLIENT_SECRET`] = savedGraph;
    }
  });
});
