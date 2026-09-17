import { PrismaClient } from "@prisma/client";
import { migrateLegacyUser, LegacyMigrationContext } from "../lib/db/legacy-user-mapper";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting Migration Bridge Test...");

  // Setup context
  const org = await prisma.organization.create({ data: { name: "Migrated Org" } });
  const tenant = await prisma.tenant.create({ data: { name: "Default Tenant", organizationId: org.id } });
  const provider = await prisma.providerConnection.create({
    data: {
      name: "Legacy Entra",
      organizationId: org.id,
      providerType: "MICROSOFT_ENTRA",
      externalScopeId: "legacy-tid"
    }
  });

  const context: LegacyMigrationContext = {
    organizationId: org.id,
    tenantId: tenant.id,
    providerConnectionId: provider.id
  };

  // TEST 1: User with azureId -> Subject + IdentityAccount + Bridge
  const user1 = await prisma.user.create({
    data: { email: "user1@example.com", name: "User 1", azureId: "oid-1" }
  });

  console.log("Testing full migration for User 1...");
  await migrateLegacyUser(user1, context);

  const bridge1 = await prisma.legacyUserBridge.findUnique({ where: { legacyUserId: user1.id }, include: { subject: { include: { identities: true } } } });
  if (!bridge1 || bridge1.status !== "VALIDATED" || bridge1.subject.identities.length !== 1 || bridge1.subject.identities[0].externalObjectId !== "oid-1") {
    console.error("❌ TEST 1 FAILED");
    process.exit(1);
  }
  console.log("✅ TEST 1 PASSED");

  // TEST 2: User without azureId -> Subject + Bridge (no IdentityAccount)
  const user2 = await prisma.user.create({
    data: { email: "user2@example.com", name: "User 2" } // no azureId
  });

  console.log("Testing migration for User 2 (no azureId)...");
  await migrateLegacyUser(user2, context);

  const bridge2 = await prisma.legacyUserBridge.findUnique({ where: { legacyUserId: user2.id }, include: { subject: { include: { identities: true } } } });
  if (!bridge2 || bridge2.subject.identities.length !== 0) {
    console.error("❌ TEST 2 FAILED");
    process.exit(1);
  }
  console.log("✅ TEST 2 PASSED");

  // TEST 3: Idempotency (run migration again on User 1)
  console.log("Testing idempotency...");
  const result = await migrateLegacyUser(user1, context);
  if (result.status !== "already_migrated") {
    console.error("❌ TEST 3 FAILED");
    process.exit(1);
  }
  console.log("✅ TEST 3 PASSED");

  // Cleanup
  console.log("Cleaning up...");
  await prisma.legacyUserBridge.deleteMany({ where: { organizationId: org.id } });
  await prisma.identityAccount.deleteMany({ where: { organizationId: org.id } });
  await prisma.subject.deleteMany({ where: { organizationId: org.id } });
  await prisma.user.deleteMany({ where: { id: { in: [user1.id, user2.id] } } });
  await prisma.tenant.deleteMany({ where: { organizationId: org.id } });
  await prisma.providerConnection.deleteMany({ where: { organizationId: org.id } });
  await prisma.organization.deleteMany({ where: { id: org.id } });

  console.log("All migration tests passed! 🚀");
}

main()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
