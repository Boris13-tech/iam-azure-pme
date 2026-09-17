import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Neon database...");

  const adminRole = await prisma.role.upsert({
    where: { name: 'Administrateur' },
    update: { id: 'admin-id' },
    create: { id: 'admin-id', name: 'Administrateur', description: 'Accès complet' },
  });

  const userRole = await prisma.role.upsert({
    where: { name: 'Utilisateur Standard' },
    update: { id: 'user-id' },
    create: { id: 'user-id', name: 'Utilisateur Standard', description: 'Accès basique' },
  });

  const hrRole = await prisma.role.upsert({
    where: { name: 'Ressources Humaines' },
    update: { id: 'hr-id' },
    create: { id: 'hr-id', name: 'Ressources Humaines', description: 'Gestion RH' },
  });

  console.log("Roles created.");

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });