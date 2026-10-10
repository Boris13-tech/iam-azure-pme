import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse } from "../../../../lib/admin/http";
import { listMyAuthenticators } from "../../../../lib/auth/self-service";

export const dynamic = "force-dynamic";

// Security Journal v1 (R3): the signed-in person's own passkeys, read only (decision S2).
export async function GET() {
  try {
    const auth = await requireAuth();
    return NextResponse.json(await listMyAuthenticators(auth), { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
