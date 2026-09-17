import { NextResponse } from "next/server";
import { getGraphClient } from "@/lib/graph";
import { requireAuth } from "@/lib/auth/require-auth";
import { checkPermission } from "@/lib/auth/authorization-gateway";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth();

    const allowed = await checkPermission(auth, { action: "read", resource: "users" });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const client = await getGraphClient();
    const result = await client.api('/users').get();
    return NextResponse.json(result.value);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
