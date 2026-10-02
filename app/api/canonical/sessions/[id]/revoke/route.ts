import { NextResponse } from "next/server";
import { revokeSession } from "@/lib/admin/canonical-administration";
import {
  canonicalAdminErrorResponse,
  mutationChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireCanonicalAccess("sessions", "revoke");
    const { id } = await params;
    return NextResponse.json(await revokeSession(auth, id, mutationChangeId(request)));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
