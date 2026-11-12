import { NextResponse } from "next/server";
import { MONITORING_TOKEN_HEADER, monitoringTokenAccepted, readiness } from "@/lib/monitoring/readiness";

// Readiness for the external monitor and the Production deploy (monitoring design, M-B): the authorization
// configuration, the database and the session path. Without the monitoring token the answer is exactly what the
// middleware gives any unauthenticated /api path, so the endpoint reveals nothing.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  if (!monitoringTokenAccepted(req.headers.get(MONITORING_TOKEN_HEADER))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { ready, checks } = await readiness();
  return NextResponse.json({ ready, checks }, { status: ready ? 200 : 503, headers: noStore });
}
