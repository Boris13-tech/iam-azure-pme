import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createProviderConnection,
  listProviderConnections,
} from "@/lib/admin/canonical-administration";
import {
  canonicalAdminErrorResponse,
  jsonBody,
  mutationChangeId,
  readChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  providerType: z.enum([
    "MICROSOFT_ENTRA",
    "LUXIA_LOCAL",
    "LDAP",
    "ACTIVE_DIRECTORY",
    "SAMBA_AD",
    "AWS",
    "GOOGLE_WORKSPACE",
    "GITHUB",
    "CUSTOM",
  ]),
  externalScopeId: z.string().trim().min(1).max(512),
  name: z.string().trim().min(1).max(200),
}).strict();

export async function GET() {
  try {
    const auth = await requireCanonicalAccess("providers", "read");
    return NextResponse.json(await listProviderConnections(auth, readChangeId("providers")));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireCanonicalAccess("providers", "manage");
    const input = await jsonBody(request, createSchema);
    const provider = await createProviderConnection(auth, input, mutationChangeId(request));
    return NextResponse.json(provider, { status: 201 });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
