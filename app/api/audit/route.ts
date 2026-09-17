import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { requireAuth } from "@/lib/auth/require-auth";
import { hasLegacyPermission } from "@/lib/auth/legacy-auth-adapter";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth();

    const allowed = await hasLegacyPermission(auth, "read", "audit");
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { searchParams } = new URL(req.url);
    const skip = parseInt(searchParams.get("skip") || "0");
    const take = parseInt(searchParams.get("take") || "50");

    const logs = await rawPrisma.auditLog.findMany({
      skip,
      take,
      where: {
        actor: {
          migrationBridge: {
            organizationId: auth.organizationId,
            status: "VALIDATED"
          }
        }
      },
      orderBy: { timestamp: "desc" },
      include: { actor: { select: { name: true, email: true } } }
    });

    return NextResponse.json(logs);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Audit API Error:", error);
    return NextResponse.json({ error: "Failed to fetch audit logs" }, { status: 500 });
  }
}