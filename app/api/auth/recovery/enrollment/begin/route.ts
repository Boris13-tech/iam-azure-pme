import { NextResponse } from "next/server";
import { beginRecoveryEnrollment, RecoveryError } from "../../../../../../lib/auth/recovery";
import { getRecoveryContext } from "../../../../../../lib/auth/recovery-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// First Admin / Break-glass v1, B2 (allow-list entry 1 of 3): a recovery session starts the enrolment
// of a new passkey for its own identity account. Nothing in the request names an account.
export async function POST(request: Request) {
  try {
    const recovery = await getRecoveryContext();
    if (!recovery) return NextResponse.json({ error: "RECOVERY_SESSION_INVALID" }, { status: 401 });
    const options = await beginRecoveryEnrollment(recovery, new URL(request.url).hostname);
    return NextResponse.json(options, { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    if (error instanceof RecoveryError) return NextResponse.json({ error: error.code }, { status: error.status });
    console.error("RECOVERY_ENROLLMENT_BEGIN_FAILED");
    return NextResponse.json({ error: "RECOVERY_UNAVAILABLE" }, { status: 503 });
  }
}
