import { NextResponse } from "next/server";
import { disableIdentityAccount } from "@/lib/admin/canonical-administration";
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
    const auth = await requireCanonicalAccess("identity_accounts", "disable");
    const { id } = await params;
    return NextResponse.json(await disableIdentityAccount(auth, id, mutationChangeId(request)));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
