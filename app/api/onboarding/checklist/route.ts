import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth/require-auth";
import { canonicalAdminErrorResponse, readChangeId } from "../../../../lib/admin/http";
import { getOnboardingChecklist } from "../../../../lib/onboarding/checklist";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await requireAuth();
    return NextResponse.json({ items: await getOnboardingChecklist(auth, readChangeId("ONBOARDING.CHECKLIST.READ")) }, { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
