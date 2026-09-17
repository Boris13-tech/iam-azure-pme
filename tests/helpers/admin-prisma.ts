import { PrismaClient } from "@prisma/client";

// adminPrisma is strictly for test fixtures (setup/cleanup) to bypass RLS.
// It relies on DATABASE_MIGRATION_URL, which connects as the superuser/schema owner (prisma)
// who has bypassrls rights, unlike the app_user.
export const adminPrisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL,
    },
  },
});
