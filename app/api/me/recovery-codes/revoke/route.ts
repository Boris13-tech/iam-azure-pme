import { NextResponse } from "next/server";
import { requireAuth } from "../../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse, mutationChangeId } from "../../../../../lib/admin/http";
import { revokeRecoveryCodes } from "../../../../../lib/auth/recovery";

export const dynamic = "force-dynamic";

// First Admin / Break-glass v1, B2: "revoke all my codes" (own account, FULL session only).
export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    const changeId = mutationChangeId(request);
    return NextResponse.json(await revokeRecoveryCodes(auth, changeId), { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
