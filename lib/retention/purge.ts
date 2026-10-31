import { createHash, timingSafeEqual } from "node:crypto";
import { rawPrisma } from "@/lib/db/raw-prisma";

// R3 daily job (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md). The platform's cron calls the
// endpoint with "Authorization: Bearer <CRON_SECRET>". Without a configured secret of at least 32
// characters, nothing is accepted. Dry run until LUXIA_RETENTION_ENFORCE is "true" (design: 7 days of
// counts first).
export const RETENTION_BATCH = 1000;

export function cronAuthorized(presented: string | null, configured = process.env.CRON_SECRET): boolean {
  if (!presented || !configured || configured.length < 32) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(`Bearer ${configured}`));
}

export const retentionEnforced = (value = process.env.LUXIA_RETENTION_ENFORCE) => value === "true";

export type RetentionCounts = { localAuthChallenges: number; authTransactions: number; retentionRuns: number; enforced: boolean };

/** One bounded run through the database function; it records its own counts. */
export async function purgeExpiredTransactions(enforce = retentionEnforced(), db = rawPrisma): Promise<RetentionCounts> {
  const [row] = await db.$queryRaw<Array<{ counts: RetentionCounts }>>`
    SELECT luxia_retention_purge_transactions(${RETENTION_BATCH}::integer, ${enforce}::boolean) AS counts`;
  return row.counts;
}
