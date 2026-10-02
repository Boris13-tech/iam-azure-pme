import { rawPrisma } from "../db/raw-prisma";

export async function cleanupShadowObservations(daysToKeep = 7) {
  const threshold = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
  
  const result = await rawPrisma.authorizationShadowObservation.deleteMany({
    where: {
      createdAt: {
        lt: threshold
      }
    }
  });

  return result.count;
}
