// Decides whether a SCHEDULED run of backup.yml backs up (docs/operations/BACKUP-RUNBOOK.md, section 2).
// The Azure Logic App is the primary hourly trigger (workflow_dispatch at :53 UTC); GitHub's schedule (:23) is a
// fallback that backs up only when no dispatched backup succeeded in the last `windowMinutes`. So the schedule never
// doubles the backups while Azure works, and catches up 30 minutes after a missed Azure slot.
// Fail-open: anything unreadable means "back up" (an extra backup is harmless; a missing one is not).
// Usage: node schedule-gate.mjs <runs.json from the GitHub API> <this run id> <window minutes>   → prints run=true|false
import { readFileSync } from "node:fs";

/** runs: GitHub workflow runs (any order). Only successful workflow_dispatch runs prove a backup happened. */
export function decide(runs, nowMs, selfRunId, windowMinutes) {
  if (!Array.isArray(runs) || !Number.isFinite(nowMs) || !(windowMinutes > 0)) return { run: true, reason: "unreadable" };
  const since = nowMs - windowMinutes * 60_000;
  const recent = runs.filter((r) => r && String(r.id) !== String(selfRunId) && r.event === "workflow_dispatch"
    && r.status === "completed" && r.conclusion === "success" && Date.parse(r.created_at) >= since);
  return recent.length ? { run: false, reason: `backup-${Math.round((nowMs - Date.parse(recent[0].created_at)) / 60_000)}min-ago` } : { run: true, reason: "no-recent-backup" };
}

if (process.argv[1]?.endsWith("schedule-gate.mjs")) {
  const [file, selfRunId, window] = process.argv.slice(2);
  let decision;
  try { decision = decide(JSON.parse(readFileSync(file, "utf8")).workflow_runs, Date.now(), selfRunId, Number(window)); }
  catch { decision = { run: true, reason: "unreadable" }; }
  console.error(`schedule gate: ${decision.run ? "back up" : "skip"} (${decision.reason})`);
  console.log(`run=${decision.run}`);
}
