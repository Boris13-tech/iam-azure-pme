import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse, mutationChangeId, readChangeId } from "../../../../lib/admin/http";
import { addDomain, listDomains } from "../../../../lib/onboarding/domains";

export const dynamic = "force-dynamic";
const noStore = { headers: { "Cache-Control": "no-store, private" } };

export async function GET() {
  try {
    const auth = await requireAuth();
    return NextResponse.json({ domains: await listDomains(auth, readChangeId("DOMAIN.READ")) }, noStore);
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}

// The TXT value is returned once, in this answer only; the database keeps its hash.
export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    const changeId = mutationChangeId(request);
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await addDomain(auth, changeId, body?.domain), noStore);
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
