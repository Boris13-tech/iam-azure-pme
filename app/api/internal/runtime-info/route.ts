import { NextRequest, NextResponse } from "next/server";
import { resolveAuthorizationMode } from "@/lib/auth/authorization-gateway";
import { PROVENANCE_TOKEN_HEADER, provenanceTokenAccepted } from "@/lib/monitoring/provenance-token";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const provided = req.headers.get(PROVENANCE_TOKEN_HEADER);

  if (!provenanceTokenAccepted(provided)) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: NO_STORE }
    );
  }

  return NextResponse.json({
    environment: process.env.APP_ENV ?? "unknown",
    gitSha:
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.GIT_COMMIT_SHA ??
      "unknown",
    // The mode the gateway actually applies ("refused" when Production has no valid mode).
    authzMode: resolveAuthorizationMode() ?? "refused"
  }, { headers: NO_STORE });
}
