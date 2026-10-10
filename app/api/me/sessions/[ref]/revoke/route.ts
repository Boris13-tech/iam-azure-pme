import { NextResponse } from "next/server";
import { requireAuth } from "../../../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse, mutationChangeId } from "../../../../../../lib/admin/http";
import { revokeMySession } from "../../../../../../lib/auth/self-service";

export const dynamic = "force-dynamic";

// Security Journal v1 (R2): revoke one of one's own sessions. The x-luxia-change-id header is
// required (replay protection; a custom header also forces a CORS preflight).
export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const auth = await requireAuth();
    const changeId = mutationChangeId(request);
    const { ref } = await params;
    return NextResponse.json(await revokeMySession(auth, ref, changeId), { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
