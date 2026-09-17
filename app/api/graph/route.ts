import { NextResponse } from "next/server";
import { getGraphClient } from "@/lib/graph";
import { requireAuth } from "@/lib/auth/require-auth";
import { hasLegacyPermission } from "@/lib/auth/legacy-auth-adapter";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth();

    const allowed = await hasLegacyPermission(auth, "read", "users");
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