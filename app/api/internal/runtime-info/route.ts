import { NextRequest, NextResponse } from "next/server";
import { resolveAuthorizationMode } from "@/lib/auth/authorization-gateway";

export async function GET(req: NextRequest) {
  const expected = process.env.STAGING_PROVENANCE_TOKEN;
  const provided = req.headers.get("x-luxia-provenance-token");

  if (!expected || provided !== expected) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404 }
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
  });
}
