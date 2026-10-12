import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse, mutationChangeId } from "../../../../lib/admin/http";
import { CanonicalAdminError } from "../../../../lib/admin/canonical-admin-error";
import { generateRecoveryCodes, recoveryCodeStatus } from "../../../../lib/auth/recovery";
import { allowRequest } from "../../../../lib/security/rate-limit";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, private" };

// First Admin / Break-glass v1, B2: the signed-in person's own recovery codes (FULL session only; a
// recovery session gets 401 like any other route). GET never returns a code: only the count left,
// the batch date and whether a recovery used the current batch (R5 notice).
export async function GET() {
  try {
    const auth = await requireAuth();
    return NextResponse.json(await recoveryCodeStatus(auth), { headers: NO_STORE });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}

// A new batch of 10 codes, shown once in this answer and never again. It needs a passkey sign-in
// less than 15 minutes old (R2) and the x-luxia-change-id header (replay protection, CORS preflight).
export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    const changeId = mutationChangeId(request);
    if (!await allowRequest("recovery-generate", `subject:${auth.organizationId}:${auth.subjectId}`))
      throw new CanonicalAdminError("RATE_LIMITED", 429);
    return NextResponse.json(await generateRecoveryCodes(auth, changeId), { headers: NO_STORE });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
