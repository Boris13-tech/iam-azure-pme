import { NextResponse } from "next/server";
import { listCanonicalAdminAudit } from "@/lib/admin/canonical-administration";
import {
  canonicalAdminErrorResponse,
  readChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireCanonicalAccess("audit", "read");
    const url = new URL(request.url);
    const events = await listCanonicalAdminAudit(auth, {
      skip: Number(url.searchParams.get("skip") ?? 0),
      take: Number(url.searchParams.get("take") ?? 50),
      operation: url.searchParams.get("operation") ?? undefined,
      changeId: readChangeId("audit"),
    });
    return NextResponse.json(events);
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
