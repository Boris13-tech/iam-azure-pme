// Decides whether a SCHEDULED run of backup.yml backs up (docs/operations/BACKUP-RUNBOOK.md, section 2).
// The Azure Logic App is the primary hourly trigger (workflow_dispatch at :53 UTC); GitHub's schedule is a fallback
// that backs up only when no dispatched backup succeeded in the last `windowMinutes` (65: one hourly slot plus margin).
// The decision is taken when the scheduled run starts, whatever its delay: while Azure keeps its slots, a dispatched
// backup is always under 65 minutes old and the schedule never doubles; after a missed slot, it catches up.
// Fail-open: anything unreadable means "back up" (an extra backup is harmless; a missing one is not).
// Usage: node schedule-gate.mjs <runs.json from the GitHub API> <this run id> <window minutes>   → prints run=true|false
import { readFileSync } from "node:fs";

const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

/**
 * runs: GitHub workflow runs (any order, any status). Proof that the primary trigger is working is a run on `main`
 * started by workflow_dispatch (Azure, or by hand) within the window that either SUCCEEDED or is still QUEUED or
 * RUNNING (the workflow's concurrency group makes this scheduled run wait behind it anyway, so a second backup would
 * be redundant). A scheduled run never counts: it may have skipped. A failed or cancelled dispatch never counts.
 */
export function decide(runs, nowMs, selfRunId, windowMinutes) {
  if (!Array.isArray(runs) || !Number.isFinite(nowMs) || !(windowMinutes > 0)) return { run: true, reason: "unreadable" };
  const since = nowMs - windowMinutes * 60_000;
  const proof = runs.filter((r) => r && String(r.id) !== String(selfRunId) && r.event === "workflow_dispatch"
    && (r.head_branch === undefined || r.head_branch === "main") && Date.parse(r.created_at) >= since
    && ((r.status === "completed" && r.conclusion === "success") || ACTIVE.has(r.status)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!proof.length) return { run: true, reason: "no-recent-dispatched-backup" };
  const age = Math.round((nowMs - Date.parse(proof[0].created_at)) / 60_000);
  return { run: false, reason: proof[0].status === "completed" ? `backup-${age}min-ago` : `dispatched-backup-${proof[0].status}-${age}min-ago` };
}

if (process.argv[1]?.endsWith("schedule-gate.mjs")) {
  const [file, selfRunId, window] = process.argv.slice(2);
  let decision;
  try { decision = decide(JSON.parse(readFileSync(file, "utf8")).workflow_runs, Date.now(), selfRunId, Number(window)); }
  catch { decision = { run: true, reason: "unreadable" }; }
  console.error(`schedule gate: ${decision.run ? "back up" : "skip"} (${decision.reason})`);
  console.log(`run=${decision.run}`);
}
