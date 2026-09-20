import {
  ProviderAdapterError,
  assertProviderOperationContext,
  type ProviderOperationContext,
} from "../..";
import { rawPrisma } from "../../../db/raw-prisma";
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

    const [tenant, connection] = await Promise.all([
      rawPrisma.tenant.findFirst({
        where: {
          id: context.tenantId,
          organizationId: context.organizationId,
        },
        select: { id: true },
      }),
      rawPrisma.providerConnection.findFirst({
        where: {
          id: context.providerConnectionId,
          organizationId: context.organizationId,
          providerType: "MICROSOFT_ENTRA",
        },
        select: { id: true, externalScopeId: true },
      }),
    ]);

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
  const tenant = await rawPrisma.tenant.findFirst({
    where: { id: input.tenantId, organizationId: input.organizationId },
    select: { id: true },
  });
  if (!tenant) {
    throw new ProviderAdapterError({
      code: "INVALID_SCOPE",
      message: "Tenant is outside the requested organization",
    });
  }
  const connection = await rawPrisma.providerConnection.findFirst({
    where: {
      organizationId: input.organizationId,
      providerType: "MICROSOFT_ENTRA",
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!connection) {
    throw new ProviderAdapterError({
      code: "NOT_FOUND",
      message: "No Microsoft Entra connection is configured for this scope",
    });
  }
  return connection.id;
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
