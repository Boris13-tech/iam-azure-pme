import { NextResponse } from "next/server";
import { z } from "zod";
import {
  linkIdentityAccount,
  listIdentityAccounts,
} from "@/lib/admin/canonical-administration";
import {
  canonicalAdminErrorResponse,
  jsonBody,
  mutationChangeId,
  readChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

export const dynamic = "force-dynamic";

const linkSchema = z.object({
  subjectId: z.string().uuid(),
  providerConnectionId: z.string().uuid(),
  externalObjectId: z.string().trim().min(1).max(512),
}).strict();

export async function GET() {
  try {
    const auth = await requireCanonicalAccess("identity_accounts", "read");
    return NextResponse.json(await listIdentityAccounts(auth, readChangeId("identity_accounts")));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireCanonicalAccess("identity_accounts", "link");
    const input = await jsonBody(request, linkSchema);
    const account = await linkIdentityAccount(auth, input, mutationChangeId(request));
    return NextResponse.json(account, { status: 201 });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
