import type { Prisma } from "@prisma/client";
import { adminPrisma } from "./admin-prisma";

/**
 * Test databases only: removes a test organization's rows, its journal and sign-in evidence included.
 * Since T0 those two tables are append-only for every ordinary statement, so the cleanup runs in one
 * transaction with `session_replication_role = replica`, which skips the guards. Only a real superuser may
 * set it: the CI and local test databases. Production has no superuser for LUXIA (its owner role is not
 * one), so this path does not exist there; the helper refuses anything but a superuser connection.
 */
export async function purgeTestOrganization(cleanup: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<void> {
  await adminPrisma.$transaction(async (tx) => {
    const [role] = await tx.$queryRaw<Array<{ superuser: boolean }>>`SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`;
    if (!role?.superuser) throw new Error("purgeTestOrganization runs on a test database only (superuser connection required)");
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await cleanup(tx);
  });
}
