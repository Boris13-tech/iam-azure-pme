import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { canonicalAdminErrorResponse, jsonBody, mutationChangeId } from "@/lib/admin/http";
import { CanonicalAdminError } from "@/lib/admin/canonical-administration";
import * as service from "@/lib/resources/sod-service";
export const dynamic = "force-dynamic";
const uuid = z.string().uuid();
async function handle(request: Request, route: { params: Promise<{ path: string[] }> }) {
  try {
    const auth = await requireAuth();
    const { path } = await route.params;
    const [surface, id, command] = path;
    if (path.length > 3 || (id && !uuid.safeParse(id).success)) throw new CanonicalAdminError("NOT_FOUND", 404);
    const change = request.method === "GET" ? `sod:read:${randomUUID()}` : mutationChangeId(request);
    let value: unknown;
    if (request.method === "GET" && surface === "policies" && path.length === 1) value = await service.listSoDPolicies(auth, change);
    else if (request.method === "GET" && surface === "policies" && path.length === 2) value = await service.readSoDPolicy(auth, id, change);
    else if (request.method === "GET" && surface === "conflicts" && path.length === 1) value = await service.listSoDConflicts(auth, change);
    else if (request.method === "POST" && surface === "policies" && path.length === 1) value = await service.createSoDPolicy(auth, await jsonBody(request, z.object({ key: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), scopeId: uuid }).strict()), change);
    else if (request.method === "PATCH" && surface === "policies" && path.length === 2) value = await service.setSoDPolicyStatus(auth, id, (await jsonBody(request, z.object({ status: z.enum(["ACTIVE", "DISABLED"]) }).strict())).status, change);
    else if (request.method === "POST" && surface === "policies" && command === "rules") value = await service.createSoDRule(auth, id, await jsonBody(request, z.object({ entitlementAId: uuid, entitlementBId: uuid }).strict()), change);
    else if (request.method === "DELETE" && surface === "rules" && path.length === 2) value = await service.disableSoDRule(auth, id, change);
    else if (request.method === "POST" && surface === "evaluate" && path.length === 1) value = await service.checkSoD(auth, await jsonBody(request, z.object({ subjectId: uuid, entitlementId: uuid, scope: uuid, resourceId: uuid.optional() }).strict()), change);
    else throw new CanonicalAdminError("NOT_FOUND", 404);
    return NextResponse.json(value);
  } catch (error) { return canonicalAdminErrorResponse(error); }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
