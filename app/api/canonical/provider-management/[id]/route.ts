import { NextResponse } from "next/server";
import { configureProvider, providerDetail } from "@/lib/provider-management/service";
import { providerManagementUpdateSchema } from "@/lib/provider-management/contracts";
import { canonicalAdminErrorResponse, jsonBody, mutationChangeId, readChangeId, requireCanonicalAccess } from "@/lib/admin/http";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Params) {
  try { return NextResponse.json(await providerDetail(await requireCanonicalAccess("providers", "read"),
    (await params).id, readChangeId("provider-detail")));
  } catch (error) { return canonicalAdminErrorResponse(error); }
}
export async function PATCH(request: Request, { params }: Params) {
  try { return NextResponse.json(await configureProvider(await requireCanonicalAccess("providers", "manage"),
    (await params).id, await jsonBody(request, providerManagementUpdateSchema), mutationChangeId(request)));
  } catch (error) { return canonicalAdminErrorResponse(error); }
}
