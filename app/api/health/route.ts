import { NextResponse } from "next/server";

// Public liveness for the external monitor (monitoring design, M-A): a constant answer from the application
// runtime. No database or other I/O, no version, no detail. Rendered per request, never cached.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
