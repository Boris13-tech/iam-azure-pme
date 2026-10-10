import { NextResponse } from "next/server";
import { requireAuth } from "../../../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse, mutationChangeId } from "../../../../../../lib/admin/http";
import { revokeInvitation } from "../../../../../../lib/onboarding/invitations";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth();
    const changeId = mutationChangeId(request);
    const { id } = await params;
    return NextResponse.json(await revokeInvitation(auth, changeId, id), { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
