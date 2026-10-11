import { NextResponse } from "next/server";
import { completeRecoveryEnrollment, RecoveryError } from "../../../../../../lib/auth/recovery";
import { getRecoveryContext } from "../../../../../../lib/auth/recovery-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// First Admin / Break-glass v1, B2 (allow-list entry 2 of 3): the new passkey is registered for the
// session's own account, and the recovery session ends in the same transaction (section 6). The
// cookie is cleared: the person then signs in normally with the new passkey (FULL session).
export async function POST(request: Request) {
  try {
    const recovery = await getRecoveryContext();
    if (!recovery) return NextResponse.json({ error: "RECOVERY_SESSION_INVALID" }, { status: 401 });
    const body = await request.json().catch(() => ({})) ?? {};
    const field = (key: string) => typeof body[key] === "string" ? body[key] as string : "";
    const url = new URL(request.url);
    await completeRecoveryEnrollment(recovery, {
      transactionId: body.transactionId, credentialId: field("credentialId"), clientDataJSON: field("clientDataJSON"),
      authenticatorData: field("authenticatorData"), publicKey: field("publicKey"),
    }, { rpId: url.hostname, origin: url.origin });
    const response = NextResponse.json({ status: "ENROLLED", redirectTo: "/login" }, { headers: { "Cache-Control": "no-store, private" } });
    response.cookies.set("luxia_session", "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    if (error instanceof RecoveryError) return NextResponse.json({ error: error.code }, { status: error.status });
    console.error("RECOVERY_ENROLLMENT_COMPLETE_FAILED");
    return NextResponse.json({ error: "RECOVERY_UNAVAILABLE" }, { status: 503 });
  }
}
