import { NextResponse } from "next/server";
import { cronAuthorized, runRetention } from "@/lib/retention/purge";

// Daily retention run: R3 purge of expired sign-in challenges and Microsoft sign-in transactions; R4 and R6 (dry runs
// until the hold register exists); then the status of every mechanism (counts and ages only). Without the cron secret
// the answer is exactly what the middleware gives any unauthenticated /api path.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runRetention(), { headers: noStore });
  } catch (error) {
    const code = error instanceof Error ? /RETENTION_[A-Z_]+/.exec(error.message)?.[0] : undefined;
    console.error("retention: purge failed", code ?? "UNKNOWN");
    return NextResponse.json({ error: "RETENTION_FAILED" }, { status: 500, headers: noStore });
  }
}
