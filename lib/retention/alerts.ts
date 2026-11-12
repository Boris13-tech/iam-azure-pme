import { KNOWN_ERROR_CODES, reportCheckIn, reportError } from "@/lib/monitoring/error-reporter";
import type { RetentionReport } from "@/lib/retention/purge";

// D8.3 (Private Beta scope, section 4.1): the three alerts of the daily retention run, sent through the error reporter
// (constants only, no row content, no organization): a failed run, no run for 3 days, and a record past its period
// plus 3 days. A hold past its review date raises its own alert (section 4.3). Without LUXIA_ERROR_DSN nothing is sent;
// the job's own log lines stay either way. Each call is bounded by the reporter's timeout and never throws.
const ROUTE = "/api/internal/retention";

/** After a run that finished: the check-in the watcher expects every day, then what the run found. */
export async function reportRetentionOutcome(report: Pick<RetentionReport, "overdue" | "holdReviewOverdue">) {
  const checkIn = await reportCheckIn("retention-daily", "ok");
  const backlog = report.overdue ? await reportError(new Error("RETENTION_BACKLOG"), "retention", ROUTE) : false;
  const holdReview = report.holdReviewOverdue ? await reportError(new Error("RETENTION_HOLD_REVIEW_OVERDUE"), "retention", ROUTE) : false;
  return { checkIn, backlog, holdReview };
}

/** After a run that failed: the error with its code when it is a known one, and a failed check-in. */
export async function reportRetentionFailure(code: string | undefined) {
  const error = await reportError(new Error(code && KNOWN_ERROR_CODES.has(code) ? code : "RETENTION_FAILED"), "retention", ROUTE);
  const checkIn = await reportCheckIn("retention-daily", "error");
  return { error, checkIn };
}

export const RETENTION_ALERT_DRILLS = ["failed-run", "backlog", "silence"] as const;
export type RetentionAlertDrill = (typeof RETENTION_ALERT_DRILLS)[number];
export const isRetentionAlertDrill = (value: string): value is RetentionAlertDrill => (RETENTION_ALERT_DRILLS as readonly string[]).includes(value);

/**
 * Alert drills (G7: each alert tested once), asked for with the cron secret. A drill touches no data and runs no purge:
 * it sends the same kind of signal as the real alert, named as a drill. "silence" sends one check-in to a monitor that
 * expects one every minute, so the watcher's missed-check-in alert fires within minutes; delete that monitor afterwards.
 */
export async function retentionAlertDrill(kind: RetentionAlertDrill) {
  if (kind === "failed-run") return { drill: kind, sent: await reportError(new Error("RETENTION_ALERT_DRILL_FAILED_RUN"), "retention", ROUTE) };
  if (kind === "backlog") return { drill: kind, sent: await reportError(new Error("RETENTION_ALERT_DRILL_BACKLOG"), "retention", ROUTE) };
  return { drill: kind, sent: await reportCheckIn("retention-daily-drill", "ok") };
}
