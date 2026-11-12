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
  // A short count does not prove that nothing is left: the deletes skip rows another transaction holds locked. One dry
  // call (a plain count, which locks do not hide) checks what is still eligible; anything left is a backlog.
  if (enforce && !total.backlog) {
    const [left] = await db.$queryRaw<Array<{ counts: CallCounts }>>`
      SELECT luxia_retention_purge_transactions(${RETENTION_BATCH}::integer, ${false}::boolean) AS counts`;
    total.backlog = [left.counts.localAuthChallenges, left.counts.authTransactions, left.counts.retentionRuns].some((count) => count > 0);
  }
  // Counts only: an alert for the operator that expired rows outpace the daily run.
  if (total.backlog) console.error("retention: backlog remains", JSON.stringify({ rounds: total.rounds, enforced: enforce }));
  return total;
}

/**
 * R4 (finished invitations) and R6 (people retired for 30 days) run as dry runs only, whatever LUXIA_RETENTION_ENFORCE
 * says. The hold register exists (D8.2): both skip a held organization (Beta scope, section 4.3). Lifting the dry run is
 * a separate reviewed change, with the database guard that refuses enforcement to the runtime role.
 */
export const R4_R6_ENFORCE_AVAILABLE = false;

type MechanismStatus = { eligible: number; overdue: number; oldestHours: number };
/** R4 and R6 count only what they may act on; "held" is what holds keep. */
type HeldMechanismStatus = MechanismStatus & { held: number };
export type RetentionStatus = { R3: MechanismStatus; R4: HeldMechanismStatus; R6: HeldMechanismStatus;
  holds: { active: number; overdueReview: number } };
export type RetentionReport = {
  r3: RetentionCounts;
  r4: { invitations: number; enforced: boolean };
  r6: { subjects: number; displayNames: number; principalNames: number; enforced: boolean };
  status: RetentionStatus;
  overdue: boolean;
  holdReviewOverdue: boolean;
};

/**
 * The daily retention run: R3 (enforced when enabled), R4 and R6 (dry runs for now), then the status of every mechanism
 * (eligible records, records past their period plus 3 days, age of the oldest). Every call is recorded by the database
 * (owner-only RetentionRun); this returns counts and ages only. A record past its period plus 3 days is the backlog
 * alert (Beta scope, section 4.1). A hold past its review date stays in effect and raises the overdue-review alert
 * (section 4.3). Their delivery to the operator is wired with the error reporter (D8.3).
 */
export async function runRetention(enforce = retentionEnforced(), db = rawPrisma): Promise<RetentionReport> {
  const r3 = await purgeExpiredTransactions(enforce, db);
  const enforceR4R6 = enforce && R4_R6_ENFORCE_AVAILABLE;
  const [r4] = await db.$queryRaw<Array<{ counts: RetentionReport["r4"] }>>`
    SELECT luxia_retention_purge_invitations(${RETENTION_BATCH}::integer, ${enforceR4R6}::boolean) AS counts`;
  const [r6] = await db.$queryRaw<Array<{ counts: RetentionReport["r6"] }>>`
    SELECT luxia_retention_pseudonymize_retired(${RETENTION_BATCH}::integer, ${enforceR4R6}::boolean) AS counts`;
  const [status] = await db.$queryRaw<Array<{ status: RetentionStatus }>>`SELECT luxia_retention_status() AS status`;
  const overdue = (["R3", "R4", "R6"] as const).some((mechanism) => status.status[mechanism].overdue > 0);
  if (overdue) {
    const counts = Object.fromEntries((["R3", "R4", "R6"] as const).map((m) => [m, { overdue: status.status[m].overdue, oldestHours: status.status[m].oldestHours }]));
    console.error("retention: records past their period plus 3 days", JSON.stringify(counts));
  }
  const holdReviewOverdue = status.status.holds.overdueReview > 0;
  if (holdReviewOverdue) console.error("retention: holds past their review date", JSON.stringify(status.status.holds));
  return { r3, r4: r4.counts, r6: r6.counts, status: status.status, overdue, holdReviewOverdue };
}
