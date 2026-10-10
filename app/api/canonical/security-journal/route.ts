import { NextResponse } from "next/server";
import { canonicalAdminErrorResponse, requireCanonicalAccess } from "../../../../lib/admin/http";
import { CanonicalAdminError } from "../../../../lib/admin/canonical-administration";
import { listSecurityJournal } from "../../../../lib/audit/security-journal";

export const dynamic = "force-dynamic";

// Security Journal v1 (R1). Gated by audit.read; tenant and actor are server-derived.
export async function GET(request: Request) {
  try {
    const auth = await requireCanonicalAccess("audit", "read");
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") ?? "all";
    if (kind !== "all" && kind !== "sign-in" && kind !== "admin") throw new CanonicalAdminError("INVALID_REQUEST", 400);
    let page;
    try {
      page = await listSecurityJournal(auth, { limit: Number(url.searchParams.get("limit") ?? 50), cursor: url.searchParams.get("cursor"),
        includeReads: url.searchParams.get("includeReads") === "true", kind });
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_CURSOR") throw new CanonicalAdminError("INVALID_REQUEST", 400);
      throw error;
    }
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
