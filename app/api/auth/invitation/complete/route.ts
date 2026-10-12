import { NextResponse } from "next/server";
import { InvitationError, completeAcceptance } from "../../../../../lib/onboarding/invitations";
import { allowRequest, clientNetworkKey } from "../../../../../lib/security/rate-limit";

export const runtime = "nodejs";

// Invitation acceptance, step 2: one transaction with the invitation's own tenant, person and role.
// No session is opened: the person then signs in with the new passkey.
export async function POST(request: Request) {
  if (!await allowRequest("invitation-accept", clientNetworkKey(request))) return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = await request.json().catch(() => ({})) ?? {};
    const field = (key: string) => typeof body[key] === "string" ? body[key] as string : "";
    const url = new URL(request.url);
    const result = await completeAcceptance({
      token: body.token, principalName: body.principalName, credentialId: field("credentialId"), clientDataJSON: field("clientDataJSON"),
      authenticatorData: field("authenticatorData"), publicKey: field("publicKey"),
    }, { rpId: url.hostname, origin: url.origin });
    return NextResponse.json({ status: "ACCEPTED", organization: result.organization });
  } catch (error) {
    if (error instanceof InvitationError) return NextResponse.json({ error: error.code }, { status: error.status });
    console.error("INVITATION_COMPLETE_FAILED");
    return NextResponse.json({ error: "INVITATION_UNAVAILABLE" }, { status: 503 });
  }
}
