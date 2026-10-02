import { NextResponse } from "next/server";
import { revokeAssignment } from "@/lib/admin/canonical-administration";
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
    const auth = await requireCanonicalAccess("assignments", "manage");
    const { id } = await params;
    return NextResponse.json(await revokeAssignment(auth, id, mutationChangeId(request)));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
