import { Prisma } from "@prisma/client";
import { withTenantDb } from "../../../db/scoped-client";
import { ProviderAdapterError, type ProviderOperationContext } from "../..";
import type { DirectoryCollisionQuarantine } from "./enterprise-directory-adapter";
import type { DirectoryAccountProjectionStore, DirectoryLinkCollisionStore } from "./linking";

export class PrismaDirectoryProjectionStore implements DirectoryAccountProjectionStore {
  async link(context: ProviderOperationContext, input: Parameters<DirectoryAccountProjectionStore["link"]>[1]) {
    return withTenantDb({ organizationId: context.organizationId, tenantId: context.tenantId }, async (tx) => {
      const [connection, subject] = await Promise.all([
        tx.providerConnection.findFirst({ where: { id: context.providerConnectionId, organizationId: context.organizationId,
          providerType: input.providerType } }),
        tx.subject.findFirst({ where: { id: input.subjectId, organizationId: context.organizationId, tenantId: context.tenantId } }),
      ]);
      if (!connection || !subject) throw new ProviderAdapterError({ code: "INVALID_SCOPE", message: "Directory link target is outside tenant scope" });
      const existing = await tx.identityAccount.findFirst({ where: { organizationId: context.organizationId,
        providerConnectionId: context.providerConnectionId, externalObjectId: input.externalObjectId } });
      if (existing) {
        if (existing.tenantId !== context.tenantId || existing.subjectId !== input.subjectId)
          throw new ProviderAdapterError({ code: "CONFLICT", message: "Directory projection is already linked",
            safeDetails: { reason: "EXTERNAL_ID_COLLISION" } });
        return { identityAccountId: existing.id, subjectId: existing.subjectId, externalObjectId: existing.externalObjectId,
          providerConnectionId: existing.providerConnectionId, created: false };
      }
      try {
        const created = await tx.identityAccount.create({ data: { organizationId: context.organizationId, tenantId: context.tenantId,
          subjectId: input.subjectId, providerConnectionId: context.providerConnectionId, externalObjectId: input.externalObjectId } });
        return { identityAccountId: created.id, subjectId: created.subjectId, externalObjectId: created.externalObjectId,
          providerConnectionId: created.providerConnectionId, created: true };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
          throw new ProviderAdapterError({ code: "CONFLICT", message: "Concurrent directory projection collision",
            safeDetails: { reason: "EXTERNAL_ID_COLLISION" } });
        throw error;
      }
    });
  }
}

export class PrismaDirectoryCollisionStore implements DirectoryLinkCollisionStore, DirectoryCollisionQuarantine {
  async quarantine(context: ProviderOperationContext, input: Parameters<DirectoryLinkCollisionStore["quarantine"]>[1] |
    Parameters<DirectoryCollisionQuarantine["quarantine"]>[1]): Promise<void> {
    await withTenantDb({ organizationId: context.organizationId, tenantId: context.tenantId }, async (tx) => {
      await tx.providerIdentityCollision.create({ data: { organizationId: context.organizationId, tenantId: context.tenantId,
        providerConnectionId: context.providerConnectionId, externalObjectId: input.externalObjectId,
        reasonCode: input.reasonCode, evidence: input as unknown as Prisma.InputJsonValue } });
    });
  }
}
