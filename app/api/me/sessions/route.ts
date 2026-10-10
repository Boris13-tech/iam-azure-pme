import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse } from "../../../../lib/admin/http";
import { listMySessions } from "../../../../lib/auth/self-service";

export const dynamic = "force-dynamic";

// Security Journal v1 (R2): the signed-in person's own active sessions only.
export async function GET() {
  try {
    const auth = await requireAuth();
    return NextResponse.json(await listMySessions(auth), { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
