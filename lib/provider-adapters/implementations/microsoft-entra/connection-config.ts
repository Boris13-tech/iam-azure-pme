import {
  ProviderAdapterError,
  assertProviderOperationContext,
  type ProviderOperationContext,
} from "../..";
import { withTenantDb } from "../../../db/scoped-client";
import type {
  MicrosoftEntraConnectionConfig,
  MicrosoftEntraConnectionConfigResolver,
} from "./types";

export class PrismaMicrosoftEntraConnectionConfigResolver
  implements MicrosoftEntraConnectionConfigResolver
{
  async resolve(
    context: ProviderOperationContext,
  ): Promise<MicrosoftEntraConnectionConfig> {
    assertProviderOperationContext(context);

    // Read inside the organization's scope (row-level security on connections, F2). No status check here:
    // sign-in is gated by the connection status; sign-out and configuration reads are always allowed.
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
          select: { id: true, externalScopeId: true },
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

    const suffix = context.providerConnectionId
      .replace(/[^a-zA-Z0-9]/g, "_")
      .toUpperCase();
    const scopedPrefix = `ENTRA_CONNECTION_${suffix}`;
    const oidcClientId = firstValue([
      `${scopedPrefix}_AUTH_CLIENT_ID`,
      "ENTRA_AUTH_CLIENT_ID",
    ]);
    const oidcSecretKey = firstPresentKey([
      `${scopedPrefix}_AUTH_CLIENT_SECRET`,
      "ENTRA_AUTH_CLIENT_SECRET",
    ]);

    const graphClientId = firstValue([
      `${scopedPrefix}_GRAPH_CLIENT_ID`,
      "GRAPH_CLIENT_ID",
      "NEXT_PUBLIC_GRAPH_CLIENT_ID",
    ]);
    const graphSecretKey = firstPresentKey([
      `${scopedPrefix}_GRAPH_CLIENT_SECRET`,
      "GRAPH_CLIENT_SECRET",
    ]);

    return {
      organizationId: context.organizationId,
      tenantId: context.tenantId,
      providerConnectionId: connection.id,
      directoryTenantId: connection.externalScopeId,
      redirectUri: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/callback`,
      oidcClientId,
      oidcClientSecret: oidcSecretKey ? { key: oidcSecretKey } : undefined,
      graphTenantId:
        firstValue([
          `${scopedPrefix}_GRAPH_TENANT_ID`,
          "GRAPH_TENANT_ID",
          "NEXT_PUBLIC_GRAPH_TENANT_ID",
        ]) || connection.externalScopeId,
      graphClientId,
      graphClientSecret: graphSecretKey ? { key: graphSecretKey } : undefined,
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
  // Never a "first result" (Customer Self-Onboarding v1, requirement 14): exactly one connection
  // of this organization, otherwise the choice is ambiguous and refused.
  const connections = await withTenantDb(input, (tx) => tx.providerConnection.findMany({
    where: {
      organizationId: input.organizationId,
      providerType: "MICROSOFT_ENTRA",
    },
    select: { id: true },
    take: 2,
  }));
  if (connections.length !== 1) {
    throw new ProviderAdapterError({
      code: "NOT_FOUND",
      message: connections.length === 0
        ? "No Microsoft Entra connection is configured for this scope"
        : "Several Microsoft Entra connections are configured for this scope; none is chosen implicitly",
    });
  }
  return connections[0].id;
}

function firstValue(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

function firstPresentKey(keys: string[]): string | undefined {
  return keys.find((key) => Boolean(process.env[key]));
}
