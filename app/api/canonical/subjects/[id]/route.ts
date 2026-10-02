import { NextResponse } from "next/server";
import { z } from "zod";
import { updateSubject } from "@/lib/admin/canonical-administration";
import {
  canonicalAdminErrorResponse,
  jsonBody,
  mutationChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  lifecycleState: z.enum([
    "PROVISIONING",
    "ACTIVE",
    "SUSPENDED",
    "DISABLED",
    "RECOVERY_REQUIRED",
    "RETIRED",
  ]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireCanonicalAccess("subjects", "update");
    const input = await jsonBody(request, updateSchema);
    const { id } = await params;
    return NextResponse.json(await updateSubject(auth, id, input, mutationChangeId(request)));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
