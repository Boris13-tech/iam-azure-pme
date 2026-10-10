import { NextResponse } from "next/server";
import { InvitationError, beginAcceptance } from "../../../../../lib/onboarding/invitations";
import { allowRequest, clientNetworkKey } from "../../../../../lib/security/rate-limit";

export const runtime = "nodejs";

// Invitation acceptance, step 1 (no session). The link's token is the only credential.
export async function POST(request: Request) {
  if (!await allowRequest("invitation-accept", clientNetworkKey(request))) return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = await request.json().catch(() => ({})) ?? {};
    return NextResponse.json(await beginAcceptance({ token: body.token, principalName: body.principalName }, new URL(request.url).hostname),
      { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    if (error instanceof InvitationError) return NextResponse.json({ error: error.code }, { status: error.status });
    console.error("INVITATION_BEGIN_FAILED");
    return NextResponse.json({ error: "INVITATION_UNAVAILABLE" }, { status: 503 });
  }
}
