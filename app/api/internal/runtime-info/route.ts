import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    environment: process.env.APP_ENV || "staging",
    gitSha: process.env.GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "unknown",
    authzMode: process.env.AUTHZ_MODE || "legacy"
  });
}
