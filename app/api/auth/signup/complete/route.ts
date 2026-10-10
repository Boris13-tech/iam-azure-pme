import { NextResponse } from "next/server";
import { SignupError, completeSignup } from "../../../../../lib/onboarding/signup";
import { allowRequest, clientNetworkKey } from "../../../../../lib/security/rate-limit";

export const runtime = "nodejs";

// Private-beta organization signup, step 2: one transaction creates the organization and its first
// administrator with the registered passkey. No session is opened: the founder then signs in.
export async function POST(request: Request) {
  if (!await allowRequest("signup", clientNetworkKey(request))) return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = await request.json().catch(() => ({})) ?? {};
    const url = new URL(request.url);
    const field = (key: string) => typeof body[key] === "string" ? body[key] as string : "";
    const result = await completeSignup({
      code: body.code, credentialId: field("credentialId"), clientDataJSON: field("clientDataJSON"),
      authenticatorData: field("authenticatorData"), publicKey: field("publicKey"),
    }, { rpId: url.hostname, origin: url.origin });
    return NextResponse.json({ status: "CREATED", organization: result.organization });
  } catch (error) {
    if (error instanceof SignupError) return NextResponse.json({ error: error.code }, { status: error.status });
    console.error("SIGNUP_COMPLETE_FAILED");
    return NextResponse.json({ error: "SIGNUP_UNAVAILABLE" }, { status: 503 });
  }
}
