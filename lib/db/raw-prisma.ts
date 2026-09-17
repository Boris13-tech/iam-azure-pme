import { PrismaClient } from "@prisma/client";

// Global instance to prevent multiple connections in dev
const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const rawPrisma = globalForPrisma.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = rawPrisma;
