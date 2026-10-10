import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse, mutationChangeId, readChangeId } from "../../../../lib/admin/http";
import { createInvitation, listInvitations } from "../../../../lib/onboarding/invitations";

export const dynamic = "force-dynamic";
const noStore = { headers: { "Cache-Control": "no-store, private" } };

export async function GET() {
  try {
    const auth = await requireAuth();
    return NextResponse.json({ invitations: await listInvitations(auth, readChangeId("INVITATION.READ")) }, noStore);
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}

// The link is returned once, for the administrator to copy. It is never sent by LUXIA (no email in v1).
// The token travels in the URL fragment, which browsers do not send to servers or in referrers.
export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    const changeId = mutationChangeId(request);
    const body = await request.json().catch(() => ({}));
    const { invitation, token } = await createInvitation(auth, changeId, { name: body?.name, role: body?.role });
    return NextResponse.json({ invitation, link: `${new URL(request.url).origin}/invitation#${token}` }, noStore);
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
