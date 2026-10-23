import { NextResponse } from "next/server";
import { startConnectionProof } from "@/lib/admin/provider-connection-proof";
import {
  canonicalAdminErrorResponse,
  mutationChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

export const dynamic = "force-dynamic";

// F4, slice S5: start a proof sign-in on a TESTING generic OIDC connection. Answers the provider's authorization URL,
// which the administrator's browser opens; the proof completes at /auth/callback, in that same session, and opens no
// session. A passing proof on the current configuration is one of the conditions of the first activation.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireCanonicalAccess("providers", "manage");
    const { id } = await params;
    return NextResponse.json(await startConnectionProof(auth, mutationChangeId(request), id));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
