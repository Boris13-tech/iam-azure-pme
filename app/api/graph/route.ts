import { NextResponse } from "next/server";
import { getGraphClient } from "@/lib/graph";
import { hasPermission } from "@/lib/permissions";

export async function GET(req: Request) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allowed = await hasPermission(userId, "read", "users");
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const client = await getGraphClient();
    const result = await client.api('/users').get();
    return NextResponse.json(result.value);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}