import { NextResponse } from "next/server";
import { requireAuth } from "../../../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse, mutationChangeId } from "../../../../../../lib/admin/http";
import { checkDomain } from "../../../../../../lib/onboarding/domains";

export const dynamic = "force-dynamic";

// Verifies a pending domain, or revalidates a verified one (LOST when the record is gone).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth();
    const changeId = mutationChangeId(request);
    const { id } = await params;
    return NextResponse.json(await checkDomain(auth, changeId, id), { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
