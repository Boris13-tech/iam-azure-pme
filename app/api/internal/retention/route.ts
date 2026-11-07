import { NextResponse } from "next/server";
import { cronAuthorized, purgeExpiredTransactions } from "@/lib/retention/purge";

// R3: daily purge of expired sign-in challenges and Microsoft sign-in transactions. Without the cron
// secret the answer is exactly what the middleware gives any unauthenticated /api path.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await purgeExpiredTransactions(), { headers: noStore });
  } catch (error) {
    const code = error instanceof Error ? /RETENTION_[A-Z_]+/.exec(error.message)?.[0] : undefined;
    console.error("retention: purge failed", code ?? "UNKNOWN");
    return NextResponse.json({ error: "RETENTION_FAILED" }, { status: 500, headers: noStore });
  }
}
