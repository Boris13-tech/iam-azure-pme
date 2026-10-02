import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { createResource, listResources } from "@/lib/admin/canonical-administration";
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
  type: z.enum([
    "APPLICATION",
    "API",
    "DATASET",
    "DATABASE",
    "REPOSITORY",
    "CLOUD_RESOURCE",
    "SAAS",
    "STORAGE",
    "SECRET",
    "AI_TOOL",
    "OTHER",
  ]),
  description: z.string().trim().max(2000).optional(),
  providerConnectionId: z.string().uuid().optional(),
  externalId: z.string().trim().max(512).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export async function GET() {
  try {
    const auth = await requireCanonicalAccess("resources", "read");
    return NextResponse.json(await listResources(auth, readChangeId("resources")));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireCanonicalAccess("resources", "manage");
    const input = await jsonBody(request, createSchema);
    const resource = await createResource(
      auth,
      { ...input, metadata: input.metadata as Prisma.InputJsonValue | undefined },
      mutationChangeId(request),
    );
    return NextResponse.json(resource, { status: 201 });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
