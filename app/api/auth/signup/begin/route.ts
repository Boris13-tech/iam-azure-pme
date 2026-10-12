import { NextResponse } from "next/server";
import { SignupError, beginSignup } from "../../../../../lib/onboarding/signup";
import { allowRequest, clientNetworkKey } from "../../../../../lib/security/rate-limit";

export const runtime = "nodejs";

// Private-beta organization signup, step 1: reserve the code, nothing is created.
export async function POST(request: Request) {
  if (!await allowRequest("signup", clientNetworkKey(request))) return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await beginSignup(body ?? {}, new URL(request.url).hostname));
  } catch (error) {
    if (error instanceof SignupError) return NextResponse.json({ error: error.code }, { status: error.status });
    console.error("SIGNUP_BEGIN_FAILED");
    return NextResponse.json({ error: "SIGNUP_UNAVAILABLE" }, { status: 503 });
  }
}
