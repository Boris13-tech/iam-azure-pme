import { NextResponse } from "next/server";
import { z } from "zod";
import { grantAssignment, listAssignments } from "@/lib/admin/canonical-administration";
import {
  canonicalAdminErrorResponse,
  jsonBody,
  mutationChangeId,
  readChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

export const dynamic = "force-dynamic";

const grantSchema = z.object({
  subjectId: z.string().uuid(),
  entitlementId: z.string().uuid(),
  sourceRef: z.string().trim().min(1).max(200).optional(),
  roleKey: z.string().trim().min(1).max(100).optional(),
  roleVersion: z.number().int().positive().optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
}).strict().refine(
  (value) => (value.roleKey == null) === (value.roleVersion == null),
  { message: "roleKey and roleVersion must be supplied together" },
);

export async function GET() {
  try {
    const auth = await requireCanonicalAccess("assignments", "read");
    return NextResponse.json(await listAssignments(auth, readChangeId("assignments")));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireCanonicalAccess("assignments", "manage");
    const input = await jsonBody(request, grantSchema);
    const assignment = await grantAssignment(auth, input, mutationChangeId(request));
    return NextResponse.json(assignment, { status: 201 });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
