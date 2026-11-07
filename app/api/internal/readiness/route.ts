import { NextResponse } from "next/server";
import { MONITORING_TOKEN_HEADER, databaseReady, monitoringTokenAccepted } from "@/lib/monitoring/readiness";

// Database readiness for the external monitor (monitoring design, M-B). Without the monitoring token the
// answer is exactly what the middleware gives any unauthenticated /api path, so the endpoint reveals nothing.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  if (!monitoringTokenAccepted(req.headers.get(MONITORING_TOKEN_HEADER))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const ready = await databaseReady();
  return NextResponse.json({ ready }, { status: ready ? 200 : 503, headers: noStore });
}
