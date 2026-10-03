import { NextResponse } from "next/server";
import { z } from "zod";
import { rejectCollisionProjection } from "@/lib/provider-management/service";
import { canonicalAdminErrorResponse, jsonBody, mutationChangeId, requireCanonicalAccess } from "@/lib/admin/http";
export async function POST(request: Request, { params }: { params: Promise<{ id: string; collisionId: string }> }) {
  try {
    const auth = await requireCanonicalAccess("providers", "manage");
    await jsonBody(request, z.object({ disposition: z.literal("REJECT_PROJECTION") }).strict());
    const { id, collisionId } = await params;
    return NextResponse.json(await rejectCollisionProjection(auth, id, collisionId, mutationChangeId(request)));
  } catch (error) { return canonicalAdminErrorResponse(error); }
}
