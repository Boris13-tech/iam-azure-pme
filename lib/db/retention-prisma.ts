import { PrismaClient } from "@prisma/client";

// D8.4 (issue #150): the daily retention job connects as its own database role, luxia_retention, which holds EXECUTE
// on the four retention functions and nothing else. app_user, the role that serves every web request, holds none of
// them (migration 20261114120000), so no web path can start a destructive retention run.
//
// There is no fallback to the application's connection: without LUXIA_RETENTION_DATABASE_URL the job refuses, and the
// refusal carries a listed code so the failed-run alert names it. A silent fallback would put the privilege back on
// app_user, which is exactly what #150 removed.
const globalForRetention = global as unknown as { retentionPrisma?: PrismaClient };

export const RETENTION_CONNECTION_VARIABLE = "LUXIA_RETENTION_DATABASE_URL";

/** The job's own client. Throws RETENTION_CONNECTION_NOT_CONFIGURED when the connection is not configured. */
export function retentionPrisma(url = process.env[RETENTION_CONNECTION_VARIABLE]): PrismaClient {
  if (!url) throw new Error("RETENTION_CONNECTION_NOT_CONFIGURED");
  if (globalForRetention.retentionPrisma) return globalForRetention.retentionPrisma;
  const client = new PrismaClient({ datasources: { db: { url } } });
  // One client per process, as for the application's own: a cron invocation must not open a connection each time.
  globalForRetention.retentionPrisma = client;
  return client;
}
