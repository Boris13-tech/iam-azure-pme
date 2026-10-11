import { NextResponse } from "next/server";
import { recoverySignIn } from "../../../../../lib/auth/recovery";
import { normalizeOrganizationSlug, normalizePrincipalName, withMinimumDuration } from "../../../../../lib/auth/organization-login";
import { allowRequest, clientNetworkKey } from "../../../../../lib/security/rate-limit";

export const runtime = "nodejs";
const MINIMUM_MS = 400;

// First Admin / Break-glass v1, B2 (design section 3): recovery sign-in with a personal code. Every
// refusal is the same answer after the same minimum duration (anti-enumeration): unknown, SUSPENDED
// or CLOSED organization; unknown person; person, account or local identity not ACTIVE; wrong, used
// or revoked code; rate limit reached. Success opens a RECOVERY session (15 minutes) and nothing else.
export async function POST(request: Request) {
  const startedAt = Date.now();
  const failure = () => withMinimumDuration(startedAt, MINIMUM_MS,
    NextResponse.json({ error: "LOCAL_AUTHENTICATION_FAILED" }, { status: 401 }));
  try {
    if (!await allowRequest("recovery", clientNetworkKey(request))) return failure();
    const body = await request.json().catch(() => null) as { organization?: unknown; principalName?: unknown; code?: unknown } | null;
    const slug = normalizeOrganizationSlug(body?.organization);
    const principalName = normalizePrincipalName(body?.principalName);
    if (!slug || !principalName) return failure();
    if (!await allowRequest("recovery-identity", `identity:${slug}:${principalName}`)) return failure();
    const signedIn = await recoverySignIn({ organization: slug, principalName, code: body?.code });
    if (!signedIn) return failure();
    const response = NextResponse.json({ status: "RECOVERY", redirectTo: "/recovery" });
    response.cookies.set("luxia_session", signedIn.rawToken, { httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "lax", expires: signedIn.expiresAt, path: "/" });
    return withMinimumDuration(startedAt, MINIMUM_MS, response);
  } catch {
    console.error("LOCAL_RECOVERY_SIGN_IN_FAILED");
    return failure();
  }
}
