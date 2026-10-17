import { NextResponse } from "next/server";
import { testProviderConnection } from "@/lib/admin/provider-connection-test";
import {
  canonicalAdminErrorResponse,
  mutationChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

export const dynamic = "force-dynamic";

// F4, slice S3: test a generic OIDC connection (discovery, keys, flow) without any user. A passing test moves a
// DRAFT connection to TESTING; every run is recorded and journaled. Activation is a separate step (slice S5).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireCanonicalAccess("providers", "manage");
    const { id } = await params;
    return NextResponse.json(await testProviderConnection(auth, mutationChangeId(request), id));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
