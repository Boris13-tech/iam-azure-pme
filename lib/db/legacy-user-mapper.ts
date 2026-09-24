import { rawPrisma } from "./raw-prisma";
import { User } from "@prisma/client";

export type LegacyMigrationContext = {
  organizationId: string;
  tenantId: string;
  providerConnectionId: string;
};

/**
 * Migrate a legacy User to the new Identity Foundation models.
 * This function is idempotent: it will not duplicate entities if run multiple times.
 */
export async function migrateLegacyUser(user: User, context: LegacyMigrationContext) {
  // Use a transaction to ensure either everything is created or nothing is
  return await rawPrisma.$transaction(async (tx) => {
    // 1. Check if bridge already exists and is validated
    let bridge = await tx.legacyUserBridge.findUnique({
      where: { legacyUserId: user.id },
    });

    if (bridge?.status === "VALIDATED") {
      return { status: "already_migrated", bridge };
    }

    // 2. Find or create Subject
    let subjectId = bridge?.subjectId;
    
    if (!subjectId) {
      const subject = await tx.subject.create({
        data: {
          name: user.name,
          type: "HUMAN", // Legacy users are humans
          organizationId: context.organizationId,
          tenantId: context.tenantId,
        }
      });
      subjectId = subject.id;
    }

    // 3. Find or create IdentityAccount (only if they had an azureId)
    if (user.azureId) {
      const existingAccount = await tx.identityAccount.findUnique({
        where: {
          organizationId_providerConnectionId_externalObjectId: {
            organizationId: context.organizationId,
            providerConnectionId: context.providerConnectionId,
            externalObjectId: user.azureId
          }
        }
      });

      if (!existingAccount) {
        await tx.identityAccount.create({
          data: {
            organizationId: context.organizationId,
            tenantId: context.tenantId,
            subjectId: subjectId,
            providerConnectionId: context.providerConnectionId,
            externalObjectId: user.azureId
          }
        });
      } else if (existingAccount.subjectId !== subjectId) {
        throw new Error(`Conflict: externalObjectId ${user.azureId} is already mapped to another subject`);
      }
    }

    // 4. Create or Update Bridge
    if (!bridge) {
      bridge = await tx.legacyUserBridge.create({
        data: {
          legacyUserId: user.id,
          organizationId: context.organizationId,
          subjectId: subjectId,
          status: "VALIDATED",
          migratedAt: new Date(),
          validatedAt: new Date()
        }
      });
    } else {
      bridge = await tx.legacyUserBridge.update({
        where: { id: bridge.id },
        data: {
          status: "VALIDATED",
          validatedAt: new Date()
        }
      });
    }

    return { status: "migrated", bridge };
  });
}
