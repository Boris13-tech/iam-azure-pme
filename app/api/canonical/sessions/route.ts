import { NextResponse } from "next/server";
import { listSessions } from "@/lib/admin/canonical-administration";
import {
  canonicalAdminErrorResponse,
  readChangeId,
  requireCanonicalAccess,
} from "@/lib/admin/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await requireCanonicalAccess("sessions", "read");
    return NextResponse.json(await listSessions(auth, readChangeId("sessions")));
  } catch (error) {
    return canonicalAdminErrorResponse(error);
  }
}
