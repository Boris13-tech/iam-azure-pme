import { NextResponse } from "next/server";
import { listManagedProviders } from "@/lib/provider-management/service";
import { canonicalAdminErrorResponse, readChangeId, requireCanonicalAccess } from "@/lib/admin/http";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return NextResponse.json(await listManagedProviders(
    await requireCanonicalAccess("providers", "read"), readChangeId("providers-management")));
  } catch (error) { return canonicalAdminErrorResponse(error); }
}
