import { NextResponse } from "next/server";
import { cronAuthorized, runRetention } from "@/lib/retention/purge";
import { isRetentionAlertDrill, reportRetentionFailure, reportRetentionOutcome, retentionAlertDrill } from "@/lib/retention/alerts";

// Daily retention run: R3 purge of expired sign-in challenges and Microsoft sign-in transactions; R4 and R6 (dry runs,
// held organizations skipped); then the status of every mechanism and of the holds (counts and ages only). Its alerts
// (D8.3) go through the error reporter: a failed run, the daily check-in whose absence is the silence alert, a backlog,
// and a hold past its review date. Without the cron secret the answer is exactly what the middleware gives any
// unauthenticated /api path.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // An alert drill (?drill=failed-run, backlog or silence) sends its signal and runs nothing else.
  const drill = new URL(req.url).searchParams.get("drill");
  if (drill !== null) {
    if (!isRetentionAlertDrill(drill)) return NextResponse.json({ error: "UNKNOWN_DRILL" }, { status: 400, headers: noStore });
    return NextResponse.json(await retentionAlertDrill(drill), { headers: noStore });
  }
  try {
    const report = await runRetention();
    await reportRetentionOutcome(report);
    return NextResponse.json(report, { headers: noStore });
  } catch (error) {
    const code = error instanceof Error ? /RETENTION_[A-Z0-9_]+/.exec(error.message)?.[0] : undefined;
    console.error("retention: purge failed", code ?? "UNKNOWN");
    await reportRetentionFailure(code);
    return NextResponse.json({ error: "RETENTION_FAILED" }, { status: 500, headers: noStore });
  }
}
