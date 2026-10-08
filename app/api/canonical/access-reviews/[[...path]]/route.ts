import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { canonicalAdminErrorResponse, jsonBody, mutationChangeId } from "@/lib/admin/http";
import { CanonicalAdminError } from "@/lib/admin/canonical-administration";
import * as service from "@/lib/resources/access-reviews";
export const dynamic = "force-dynamic";
const uuid = z.string().uuid();
async function handle(request: Request, route: { params: Promise<{ path?: string[] }> }) {
  try {
    const auth = await requireAuth();
    const path = (await route.params).path ?? [];
    const [id, command, itemId, action] = path;
    const url = new URL(request.url);
    const after = url.searchParams.get("after") ?? undefined;
    if (after && !uuid.safeParse(after).success) throw new CanonicalAdminError("INVALID_CURSOR", 400);
    if (path.length > 4 || (id && id !== "configuration" && !uuid.safeParse(id).success) || (itemId && !uuid.safeParse(itemId).success)) throw new CanonicalAdminError("NOT_FOUND", 404);
    let result: unknown;
    if (request.method === "GET") {
      if (!path.length) result = await service.listAccessReviews(auth, after);
      else if (path.length === 1 && id === "configuration") result = await service.reviewConfiguration(auth);
      else if (path.length === 1) result = await service.getAccessReview(auth, id);
      else if (path.length === 2 && command === "items") result = await service.listReviewItems(auth, id, after, url.searchParams.get("pending") === "true");
      else if (path.length === 2 && command === "audit") result = await service.reviewAudit(auth, id, after);
      else throw new CanonicalAdminError("NOT_FOUND", 404);
    } else {
      const changeId = mutationChangeId(request);
      if (!path.length) {
        const body = await jsonBody(request, z.object({ name: z.string().trim().min(1).max(120), scopeId: uuid, reviewerSubjectId: uuid,
          startsAt: z.string().datetime(), dueAt: z.string().datetime() }).strict());
        result = await service.createAccessReview(auth, { ...body, startsAt: new Date(body.startsAt), dueAt: new Date(body.dueAt) }, changeId);
      } else if (path.length === 4 && command === "items" && action === "decision") result = await service.decideReviewItem(auth, id, itemId,
        await jsonBody(request, z.object({ decision: z.enum(["KEEP", "REVOKE"]), justification: z.string().trim().min(3).max(2000) }).strict()), changeId);
      else if (path.length === 2 && command === "complete") { await jsonBody(request, z.object({}).strict()); result = await service.completeAccessReview(auth, id, changeId); }
      else throw new CanonicalAdminError("NOT_FOUND", 404);
    }
    return NextResponse.json(result);
  } catch (error) { return canonicalAdminErrorResponse(error); }
}
export const GET = handle;
export const POST = handle;
