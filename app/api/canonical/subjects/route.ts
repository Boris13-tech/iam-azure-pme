import { NextResponse } from "next/server";
import { z } from "zod";
import { createSubject, listSubjects } from "@/lib/admin/canonical-administration";
import {
  canonicalAdminErrorResponse,
  jsonBody,
  mutationChangeId,
  readChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(["HUMAN", "WORKLOAD", "SERVICE", "DEVICE", "AI_AGENT"]),
}).strict();

export async function GET() {
  try {
    const auth = await requireCanonicalAccess("subjects", "read");
    return NextResponse.json(await listSubjects(auth, readChangeId("subjects")));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireCanonicalAccess("subjects", "create");
    const input = await jsonBody(request, createSchema);
    const subject = await createSubject(auth, input, mutationChangeId(request));
    return NextResponse.json(subject, { status: 201 });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
