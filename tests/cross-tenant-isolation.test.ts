import { adminPrisma } from "../helpers/admin-prisma";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting Cross-Tenant DB Test...");

  // 1. Create Org A and Org B
  const orgA = await prisma.organization.create({ data: { name: "Org A" } });
  const orgB = await prisma.organization.create({ data: { name: "Org B" } });

  // 2. Create Tenant A and Tenant B
  const tenantA = await prisma.tenant.create({ data: { name: "Tenant A", organizationId: orgA.id } });
  const tenantB = await prisma.tenant.create({ data: { name: "Tenant B", organizationId: orgB.id } });

  // 3. Create ProviderConnection B
  const providerB = await prisma.providerConnection.create({
    data: {
      name: "Entra B",
      organizationId: orgB.id,
      }
  });

  console.log("Setup complete. Testing composite boundaries...");

  // TEST 1: Create Subject in Org A but Tenant B (Should FAIL)
  try {
    await prisma.subject.create({
      data: {
        name: "Alice",
        type: "HUMAN",
        organizationId: orgA.id,
        tenantId: tenantB.id // Tenant B is in Org B
      }
    });
    console.error("❌ TEST 1 FAILED: DB allowed Subject in Org A to link to Tenant B.");
    process.exit(1);
  } catch (error: any) {
    if (error.code === 'P2003') { // Foreign key constraint failed
      console.log("✅ TEST 1 PASSED: DB rejected Org A Subject -> Tenant B.");
    } else {
      console.error("❌ Unexpected error in Test 1:", error);
      process.exit(1);
    }
  }

  // TEST 2: Create valid Subject in Org A, then IdentityAccount linking Provider B (Should FAIL)
  const subjectA = await prisma.subject.create({
    data: {
      name: "Alice",
      type: "HUMAN",
      organizationId: orgA.id,
      tenantId: tenantA.id
    }
  });

  try {
    await prisma.identityAccount.create({
      data: {
        organizationId: orgA.id,
        subjectId: subjectA.id,
        providerConnectionId: providerB.id, // Provider B is in Org B
        externalObjectId: "oid-123"
      }
    });
    console.error("❌ TEST 2 FAILED: DB allowed Org A Subject to link to Org B ProviderConnection.");
    process.exit(1);
  } catch (error: any) {
    if (error.code === 'P2003') {
      console.log("✅ TEST 2 PASSED: DB rejected Org A Subject -> Org B ProviderConnection.");
    } else {
      console.error("❌ Unexpected error in Test 2:", error);
      process.exit(1);
    }
  }

  // TEST 3: Create Resource in Org A with Provider B (Should FAIL)
  try {
    await prisma.resource.create({
      data: {
        name: "Resource A",
        type: "API",
        organizationId: orgA.id,
        tenantId: tenantA.id,
        providerConnectionId: providerB.id
      }
    });
    console.error("❌ TEST 3 FAILED: DB allowed Resource in Org A to link to Provider B.");
    process.exit(1);
  } catch (error: any) {
    if (error.code === 'P2003') {
      console.log("✅ TEST 3 PASSED: DB rejected Resource in Org A -> Org B ProviderConnection.");
    } else {
      console.error("❌ Unexpected error in Test 3:", error);
      process.exit(1);
    }
  }

  // Cleanup in correct order because of Restrict constraints
  console.log("Cleaning up...");
  await prisma.resource.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
  await prisma.identityAccount.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
  await prisma.subject.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
  await prisma.tenant.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
  await prisma.providerConnection.deleteMany({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  
  console.log("All tests passed! 🚀");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
