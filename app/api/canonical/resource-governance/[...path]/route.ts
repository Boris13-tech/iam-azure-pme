import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { canonicalAdminErrorResponse, jsonBody, mutationChangeId } from "@/lib/admin/http";
import { CanonicalAdminError } from "@/lib/admin/canonical-administration";
import * as service from "@/lib/resources/service";

export const dynamic = "force-dynamic";
const uuid = z.string().uuid();
const label = z.string().trim().min(1).max(200);
const action = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const resourceInput = z.object({ name: label, type: z.enum(["APPLICATION", "API", "SERVICE", "DEVICE", "WORKLOAD", "AI_AGENT"]) }).strict();
const scopeInput = z.object({ key: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), kind: z.enum(["RESOURCE", "RESOURCE_GROUP", "TENANT"]), resourceId: uuid.optional(), resourceIds: z.array(uuid).max(100).optional() }).strict();
const entitlementInput = z.object({ scopeId: uuid, action, label }).strict();
const assignmentInput = z.object({ subjectId: uuid, entitlementId: uuid, validUntil: z.coerce.date() }).strict();
const authorizationInput = z.object({ resourceId: uuid, entitlementKey: z.string().min(1).max(200), action }).strict();
type RouteContext = { params: Promise<{ path: string[] }> };

async function handle(request: Request, route: RouteContext) {
  try {
    const auth = await requireAuth();
    const { path } = await route.params;
    const [surface, id, command] = path;
    if (path.length > 3 || (id && !uuid.safeParse(id).success)) throw new CanonicalAdminError("NOT_FOUND", 404);
    const changeId = request.method === "GET" ? `read:resource:${randomUUID()}` : mutationChangeId(request);
    const afterRaw = new URL(request.url).searchParams.get("after");
    const after = afterRaw ? uuid.parse(afterRaw) : undefined;
    let value: unknown;
    if (request.method === "GET" && path.length === 1) {
      const readers: Record<string, (auth: Parameters<typeof service.listResources>[0], changeId: string, after?: string) => Promise<unknown>> = { resources: service.listResources,
        scopes: service.listScopes, entitlements: service.listEntitlements, assignments: service.listAssignments, audit: service.listAudit };
      const reader = readers[surface];
      if (!reader) throw new CanonicalAdminError("NOT_FOUND", 404);
      value = await reader(auth, changeId, after);
    } else if (request.method === "GET" && surface === "resources" && path.length === 2) {
      value = await service.readResource(auth, id, changeId);
    } else if (request.method === "POST" && path.length === 1) {
      if (surface === "resources") value = await service.createResource(auth, await jsonBody(request, resourceInput), changeId);
      else if (surface === "scopes") value = await service.createScope(auth, await jsonBody(request, scopeInput), changeId);
      else if (surface === "entitlements") value = await service.createEntitlement(auth, await jsonBody(request, entitlementInput), changeId);
      else if (surface === "assignments") value = await service.grantAssignment(auth, await jsonBody(request, assignmentInput), changeId);
      else if (surface === "authorize") value = await service.checkAccess(auth, await jsonBody(request, authorizationInput), changeId);
      else throw new CanonicalAdminError("NOT_FOUND", 404);
    } else if (request.method === "PATCH" && surface === "assignments" && path.length === 2) {
      value = await service.updateAssignment(auth, id, await jsonBody(request, z.object({ entitlementId: uuid.optional(), validUntil: z.coerce.date().optional(), status: z.enum(["ACTIVE", "REVOKED"]).optional() }).strict().refine(input => Object.keys(input).length > 0)), changeId);
    } else if (request.method === "PATCH" && surface === "resources" && path.length === 2) {
      value = await service.updateResource(auth, id, await jsonBody(request, z.object({ name: label.optional(), active: z.boolean().optional() }).strict().refine(input => Object.keys(input).length > 0)), changeId);
    } else if (request.method === "POST" && command === "revoke" && path.length === 3) {
      if (surface === "assignments") value = await service.revokeAssignment(auth, id, changeId);
      else if (surface === "entitlements") value = await service.revokeEntitlement(auth, id, changeId);
      else throw new CanonicalAdminError("NOT_FOUND", 404);
    } else throw new CanonicalAdminError("NOT_FOUND", 404);
    return NextResponse.json(value, { status: request.method === "POST" && ["resources", "scopes", "entitlements", "assignments"].includes(surface) && path.length === 1 ? 201 : 200 });
  } catch (error) { return canonicalAdminErrorResponse(error); }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
