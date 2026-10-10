import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse } from "../../../../lib/admin/http";
import { loadIdentitySecurityPosture } from "../../../../lib/dashboard/posture";

export const dynamic = "force-dynamic";

// Enterprise Identity Security Dashboard v1. No request parameters are read: tenant, viewer and
// permissions are server-derived. Restricted widgets are never queried.
export async function GET() {
  try {
    const auth = await requireAuth();
    return NextResponse.json(await loadIdentitySecurityPosture(auth), { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    const response = canonicalAdminErrorResponse(error);
    if (response.status !== 500) return response;
    return NextResponse.json({ error: "POSTURE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store, private" } });
  }
}
