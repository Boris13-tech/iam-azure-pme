import {
  ProviderAdapterError,
  assertProviderOperationContext,
  type ProviderOperationContext,
  type SecretReference,
} from "../..";
import { withTenantDb } from "../../../db/scoped-client";
import {
  connectionSecretReference,
  isProductionRuntime,
} from "../../infrastructure/secret-stores";
import type {
  MicrosoftEntraConnectionConfig,
  MicrosoftEntraConnectionConfigResolver,
} from "./types";

// Maximum UTF-8 byte length of a connection ID that still keeps ENTRA_CONN_HEX_<HEX>_GRAPH_CLIENT_SECRET <= 128 chars
// (15 + 90 + 20 = 125 <= 128, matching ENV_NAME in secret-stores/reference.ts). CUIDs (25 B) and UUIDs (36 B) fit easily.
const MAX_CONNECTION_ID_BYTES = 45;

/**
 * Bijective (collision-free) uppercase hexadecimal prefix for connection-scoped environment configuration.
 * Unlike lossy regex replacement (where "conn-a", "conn_a" and "Conn-A" collided), distinct connection IDs
 * always map to distinct environment variable prefixes.
 */
export function connectionScopedEnvPrefix(providerConnectionId: string): string {
  const byteLength = typeof providerConnectionId === "string"
    ? Buffer.byteLength(providerConnectionId, "utf8")
    : 0;
  if (byteLength < 1 || byteLength > MAX_CONNECTION_ID_BYTES) {
    throw new ProviderAdapterError({
      code: "INVALID_SCOPE",
      message: "Provider connection identifier cannot be mapped safely",
      safeDetails: { reason: "INVALID_CONNECTION_IDENTIFIER" },
    });
  }
  const hex = Buffer.from(providerConnectionId, "utf8").toString("hex").toUpperCase();
  return `ENTRA_CONN_HEX_${hex}`;
}

export class PrismaMicrosoftEntraConnectionConfigResolver
  implements MicrosoftEntraConnectionConfigResolver
{
  constructor(
    private readonly envSource: () => Readonly<Record<string, string | undefined>> = () => process.env,
  ) {}

  async resolve(
    context: ProviderOperationContext,
  ): Promise<MicrosoftEntraConnectionConfig> {
    assertProviderOperationContext(context);
    const env = this.envSource();
    const production = isProductionRuntime(env);

    // Read inside the organization's scope (forced RLS on ProviderConnection, F2/M2).
    const [tenant, connection] = await withTenantDb(
      { organizationId: context.organizationId, tenantId: context.tenantId },
      async (tx) => [
        await tx.tenant.findFirst({
          where: { id: context.tenantId, organizationId: context.organizationId },
          select: { id: true },
        }),
        await tx.providerConnection.findFirst({
          where: {
            id: context.providerConnectionId,
            organizationId: context.organizationId,
            providerType: "MICROSOFT_ENTRA",
          },
          select: { id: true, externalScopeId: true, status: true },
        }),
      ] as const,
    );

    if (!tenant || !connection) {
      throw new ProviderAdapterError({
        code: "INVALID_SCOPE",
        message: "Microsoft Entra connection is outside the requested scope",
        safeDetails: {
          organizationId: context.organizationId,
          tenantId: context.tenantId,
          providerConnectionId: context.providerConnectionId,
        },
      });
    }

    // G2-R02 / F2: systematically enforce ACTIVE connection status on every Entra operation (fail closed).
    if (connection.status !== "ACTIVE") {
      throw new ProviderAdapterError({
        code: "INVALID_SCOPE",
        message: "Microsoft Entra connection is not active",
        safeDetails: {
          organizationId: context.organizationId,
          tenantId: context.tenantId,
          providerConnectionId: connection.id,
          reason: "PROVIDER_CONNECTION_NOT_ACTIVE",
        },
      });
    }

    const scopedPrefix = connectionScopedEnvPrefix(connection.id);

    // F3: per-connection secret references in PostgreSQL (akv://<vault>/<secret> + pinned activeVersion).
    // Never global, never shared across connections.
    const [oidcVaultRef, directoryVaultRef] = await Promise.all([
      connectionSecretReference(context, "OIDC_CLIENT", "active"),
      connectionSecretReference(context, "DIRECTORY", "active"),
    ]);

    // In Production, environment secrets are strictly forbidden (vault references only);
    // outside Production, only connection-scoped environment secrets are accepted (never global fallbacks).
    const oidcClientSecret: SecretReference | undefined =
      oidcVaultRef ??
      (!production && env[`${scopedPrefix}_AUTH_CLIENT_SECRET`]
        ? { key: `env://${scopedPrefix}_AUTH_CLIENT_SECRET` }
        : undefined);

    const graphClientSecret: SecretReference | undefined =
      directoryVaultRef ??
      (!production && env[`${scopedPrefix}_GRAPH_CLIENT_SECRET`]
        ? { key: `env://${scopedPrefix}_GRAPH_CLIENT_SECRET` }
        : undefined);

    // Non-secret connection identifiers are also strictly per-connection (zero global fallback).
    const oidcClientId = nonEmpty(env[`${scopedPrefix}_AUTH_CLIENT_ID`]);
    const graphClientId = nonEmpty(env[`${scopedPrefix}_GRAPH_CLIENT_ID`]);
    const graphTenantId =
      nonEmpty(env[`${scopedPrefix}_GRAPH_TENANT_ID`]) ?? connection.externalScopeId;

    const appOrigin = resolveRedirectBaseUrl(env, production);

    return {
      organizationId: context.organizationId,
      tenantId: context.tenantId,
      providerConnectionId: connection.id,
      directoryTenantId: connection.externalScopeId,
      redirectUri: `${appOrigin}/auth/callback`,
      oidcClientId,
      oidcClientSecret,
      graphTenantId,
      graphClientId,
      graphClientSecret,
    };
  }
}

export async function locateMicrosoftEntraConnection(input: {
  organizationId: string;
  tenantId: string;
}): Promise<string> {
  const tenant = await withTenantDb(input, (tx) => tx.tenant.findFirst({
    where: { id: input.tenantId, organizationId: input.organizationId },
    select: { id: true },
  }));
  if (!tenant) {
    throw new ProviderAdapterError({
      code: "INVALID_SCOPE",
      message: "Tenant is outside the requested organization",
    });
  }
  // Never a "first result" (Customer Self-Onboarding v1, requirement 14) and only ACTIVE connections (G2-R02 / F2):
  // DRAFT, TESTING, DISABLED and QUARANTINED connections are never selected implicitly.
  const connections = await withTenantDb(input, (tx) => tx.providerConnection.findMany({
    where: {
      organizationId: input.organizationId,
      providerType: "MICROSOFT_ENTRA",
      status: "ACTIVE",
    },
    select: { id: true },
    take: 2,
  }));
  if (connections.length !== 1) {
    throw new ProviderAdapterError({
      code: "NOT_FOUND",
      message: connections.length === 0
        ? "No active Microsoft Entra connection is configured for this scope"
        : "Several active Microsoft Entra connections are configured for this scope; none is chosen implicitly",
    });
  }
  return connections[0].id;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveRedirectBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  production: boolean,
): string {
  const raw = nonEmpty(env.NEXT_PUBLIC_APP_URL);
  if (production) {
    if (!raw) {
      throw new ProviderAdapterError({
        code: "MISCONFIGURED",
        message: "NEXT_PUBLIC_APP_URL is required in Production",
        safeDetails: { reason: "APP_URL_MISSING" },
      });
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ProviderAdapterError({
        code: "MISCONFIGURED",
        message: "NEXT_PUBLIC_APP_URL is invalid",
        safeDetails: { reason: "APP_URL_INVALID" },
      });
    }
    if (parsed.protocol !== "https:") {
      throw new ProviderAdapterError({
        code: "MISCONFIGURED",
        message: "NEXT_PUBLIC_APP_URL must use HTTPS in Production",
        safeDetails: { reason: "APP_URL_INSECURE" },
      });
    }
    return parsed.origin;
  }
  return (raw ?? "http://localhost:3000").replace(/\/+$/, "");
}
