import { NextResponse } from "next/server";
import { z } from "zod";
import { applyConnectionTransition, planConnectionTransition } from "@/lib/admin/provider-connection-lifecycle";
import {
  canonicalAdminErrorResponse,
  jsonBody,
  mutationChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

export const dynamic = "force-dynamic";

// F2 kill switch. Without planDigest: a dry run (what would change, how many sessions a quarantine revokes).
// With the planDigest of that dry run: the change, refused if the connection changed in between.
const lifecycleSchema = z.object({
  action: z.enum(["DISABLE", "ACTIVATE", "QUARANTINE", "RELEASE"]),
  planDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireCanonicalAccess("providers", "manage");
    const input = await jsonBody(request, lifecycleSchema);
    const { id } = await params;
    const changeId = mutationChangeId(request);
    return NextResponse.json(input.planDigest
      ? await applyConnectionTransition(auth, changeId, id, input.action, input.planDigest)
      : await planConnectionTransition(auth, changeId, id, input.action));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
