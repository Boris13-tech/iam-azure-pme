import { createHash, timingSafeEqual } from "node:crypto";
import { rawPrisma } from "@/lib/db/raw-prisma";

// R3 daily job (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md). The platform's cron calls the
// endpoint with "Authorization: Bearer <CRON_SECRET>". Without a configured secret of at least 32
// characters, nothing is accepted. Dry run until LUXIA_RETENTION_ENFORCE is "true" (design: 7 days of
// counts first).
export const RETENTION_BATCH = 1000;
// One daily run keeps calling the bounded function while a call comes back full, up to these limits, so a day
// with more than one batch of expired rows is drained; what still remains is reported as a backlog.
export const RETENTION_MAX_ROUNDS = 50;
export const RETENTION_TIME_BUDGET_MS = 20_000;

export function cronAuthorized(presented: string | null, configured = process.env.CRON_SECRET): boolean {
  if (!presented || !configured || configured.length < 32) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(`Bearer ${configured}`));
}

export const retentionEnforced = (value = process.env.LUXIA_RETENTION_ENFORCE) => value === "true";

type CallCounts = { localAuthChallenges: number; authTransactions: number; retentionRuns: number; enforced: boolean };
export type RetentionCounts = CallCounts & { rounds: number; backlog: boolean };

/**
 * Bounded calls through the database function (each records its own counts), repeated while a call comes back full.
 * A dry run deletes nothing, so it makes one call: a full count there means a backlog. Counts are summed.
 */
export async function purgeExpiredTransactions(enforce = retentionEnforced(), db = rawPrisma,
  limits = { rounds: RETENTION_MAX_ROUNDS, budgetMs: RETENTION_TIME_BUDGET_MS }): Promise<RetentionCounts> {
  const started = Date.now();
  const total: RetentionCounts = { localAuthChallenges: 0, authTransactions: 0, retentionRuns: 0, enforced: enforce, rounds: 0, backlog: false };
  for (;;) {
    const [row] = await db.$queryRaw<Array<{ counts: CallCounts }>>`
      SELECT luxia_retention_purge_transactions(${RETENTION_BATCH}::integer, ${enforce}::boolean) AS counts`;
    const call = row.counts;
    total.localAuthChallenges += call.localAuthChallenges;
    total.authTransactions += call.authTransactions;
    total.retentionRuns += call.retentionRuns;
    total.rounds += 1;
    const full = [call.localAuthChallenges, call.authTransactions, call.retentionRuns].some((count) => count >= RETENTION_BATCH);
    if (!full) break;
    if (!enforce || total.rounds >= limits.rounds || Date.now() - started >= limits.budgetMs) { total.backlog = true; break; }
  }
  // Counts only: an alert for the operator that expired rows outpace the daily run.
  if (total.backlog) console.error("retention: backlog remains", JSON.stringify({ rounds: total.rounds, enforced: enforce }));
  return total;
}
