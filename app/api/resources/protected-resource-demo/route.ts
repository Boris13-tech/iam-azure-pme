import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse } from "../../../../lib/admin/http";
import { exerciseInternalCapability } from "../../../../lib/resources/onboarding";

export const dynamic = "force-dynamic";

// No request claims are read. Resource, action and Subject are server-derived.
export async function GET() {
  try {
    const auth = await requireAuth();
    const result = await exerciseInternalCapability(auth);
    return NextResponse.json(result.allowed ? { message: "LUXIA internal capability authorized", evidenceId: result.evidenceId }
      : { error: "RESOURCE_ACCESS_DENIED", evidenceId: result.evidenceId },
    { status: result.allowed ? 200 : 403, headers: { "Cache-Control": "no-store, private" } });
  } catch (error) { return canonicalAdminErrorResponse(error); }
}
