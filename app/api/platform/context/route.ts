import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/auth-context";
import { loadPlatformContext } from "@/lib/platform/context";

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  try {
    return NextResponse.json(await loadPlatformContext(auth));
  } catch {
    return NextResponse.json({ error: "CONTEXT_UNAVAILABLE" }, { status: 503 });
  }
}
