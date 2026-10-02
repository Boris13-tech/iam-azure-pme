import { NextResponse } from "next/server";
import { z } from "zod";
import { updateProviderConnection } from "@/lib/admin/canonical-administration";
import {
  canonicalAdminErrorResponse,
  jsonBody,
  mutationChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

const updateSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireCanonicalAccess("providers", "manage");
    const input = await jsonBody(request, updateSchema);
    const { id } = await params;
    return NextResponse.json(await updateProviderConnection(auth, id, input, mutationChangeId(request)));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
