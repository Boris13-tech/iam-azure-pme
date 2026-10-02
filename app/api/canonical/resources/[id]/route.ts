import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { updateResource } from "@/lib/admin/canonical-administration";
import {
  canonicalAdminErrorResponse,
  jsonBody,
  mutationChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireCanonicalAccess("resources", "manage");
    const input = await jsonBody(request, updateSchema);
    const { id } = await params;
    return NextResponse.json(await updateResource(
      auth,
      id,
      { ...input, metadata: input.metadata as Prisma.InputJsonValue | undefined },
      mutationChangeId(request),
    ));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
