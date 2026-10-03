import { NextResponse } from "next/server";
import { z } from "zod";
import { runProviderOperation } from "@/lib/provider-management/service";
import { createManagedHttpDriver } from "@/lib/provider-adapters/implementations/managed-http/driver";
import { canonicalAdminErrorResponse, jsonBody, mutationChangeId, requireCanonicalAccess } from "@/lib/admin/http";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireCanonicalAccess("providers", "manage");
    const input = await jsonBody(request, z.object({ operation: z.enum(["CONNECTION_TEST", "SYNC_DRY_RUN"]) }).strict());
    return NextResponse.json(await runProviderOperation(auth, (await params).id, input.operation,
      mutationChangeId(request), createManagedHttpDriver));
  } catch (error) { return canonicalAdminErrorResponse(error); }
}
