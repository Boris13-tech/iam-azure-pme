import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import type { ProviderOperationContext } from "./provider-adapters";
import { locateMicrosoftEntraConnection } from "./provider-adapters/implementations/microsoft-entra/connection-config";
import { getMicrosoftEntraAdapter } from "./provider-adapters/implementations/microsoft-entra/runtime";

export type ProviderScope = Readonly<{
  organizationId: string;
  tenantId: string;
}>;

export function hasMicrosoftGraphConfiguration(): boolean {
  return Boolean(
    (process.env.GRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_GRAPH_CLIENT_ID) &&
      process.env.GRAPH_CLIENT_SECRET &&
      process.env.GRAPH_CLIENT_SECRET !== "dummy_secret_to_prevent_build_crash",
  );
}

export async function listAzureUsers(scope: ProviderScope) {
  const context = await createContext(scope, "graph-list");
  return getMicrosoftEntraAdapter().listRawMicrosoftGraphUsers(context);
}

export async function syncAzureUsers(scope: ProviderScope) {
  try {
    const context = await createContext(scope, "graph-sync");
    const graphUsers = await getMicrosoftEntraAdapter().listMicrosoftGraphUsers(context);
    const graphUserIds = new Set<string>();

    for (const graphUser of graphUsers) {
      const email = (graphUser.mail || graphUser.userPrincipalName || "").toLowerCase();
      if (!email) continue;
      graphUserIds.add(graphUser.id);
      const name = graphUser.displayName || email.split("@")[0];
      const isActive = graphUser.accountEnabled !== false;
      const existingUser = await prisma.user.findFirst({
        where: { OR: [{ azureId: graphUser.id }, { email }] },
      });

      if (existingUser) {
        await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            azureId: graphUser.id,
            name,
            email,
            status: isActive ? "ACTIVE" : "INACTIVE",
          },
        });
        if ((await prisma.userRole.count({ where: { userId: existingUser.id } })) === 0) {
          await prisma.userRole.create({
            data: { userId: existingUser.id, roleId: "user-id" },
          });
        }
      } else {
        const newUser = await prisma.user.create({
          data: {
            azureId: graphUser.id,
            name,
            email,
            status: isActive ? "ACTIVE" : "INACTIVE",
          },
        });
        await prisma.userRole.create({
          data: { userId: newUser.id, roleId: "user-id" },
        });
      }
    }

    const localAzureUsers = await prisma.user.findMany({
      where: { azureId: { not: null } },
    });
    for (const localUser of localAzureUsers) {
      if (localUser.azureId && !graphUserIds.has(localUser.azureId)) {
        await prisma.user.update({
          where: { id: localUser.id },
          data: { status: "INACTIVE" },
        });
      }
    }
  } catch (error) {
    console.error("Error during Azure AD user sync:", safeProviderError(error));
  }
}

export async function createAzureUser(
  scope: ProviderScope,
  name: string,
  email: string,
) {
  const context = await createContext(scope, "graph-create");
  const created = await getMicrosoftEntraAdapter().createMicrosoftEntraUser(
    context,
    name,
    email,
  );
  return { azureId: created.id, upn: created.userPrincipalName };
}

export async function updateAzureUserStatus(
  scope: ProviderScope,
  azureId: string,
  isActive: boolean,
): Promise<void> {
  try {
    const context = await createContext(scope, "graph-status");
    await getMicrosoftEntraAdapter().updateMicrosoftEntraUser(context, azureId, {
      accountEnabled: isActive,
    });
  } catch (error) {
    console.error(`Failed to update Azure user status for ${azureId}:`, safeProviderError(error));
  }
}

export async function updateAzureUser(
  scope: ProviderScope,
  azureId: string,
  name?: string,
  email?: string,
): Promise<void> {
  try {
    const context = await createContext(scope, "graph-update");
    await getMicrosoftEntraAdapter().updateMicrosoftEntraUser(context, azureId, {
      name,
      email,
    });
  } catch (error) {
    console.error(`Failed to update Azure user ${azureId}:`, safeProviderError(error));
  }
}

async function createContext(
  scope: ProviderScope,
  operation: string,
): Promise<ProviderOperationContext> {
  const providerConnectionId = await locateMicrosoftEntraConnection(scope);
  return {
    ...scope,
    providerConnectionId,
    operationId: `${operation}:${randomUUID()}`,
  };
}

function safeProviderError(error: unknown): string {
  return error instanceof Error ? error.message : "Microsoft Entra operation failed";
}
