import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { requireAuth } from "@/lib/auth/require-auth";
import { checkPermission } from "@/lib/auth/authorization-gateway";
import { dualWriteCreateRole } from "@/lib/auth/dual-write-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth();

    const allowed = await checkPermission(auth, { action: "read", resource: "roles" });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const roles = await rawPrisma.role.findMany({
      include: { _count: { select: { users: true } }, permissions: { include: { permission: true } } }
    });

    return NextResponse.json(roles);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth();

    const allowed = await checkPermission(auth, { action: "manage", resource: "roles" });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const { name, description, permissions } = body;

    const newRole = await dualWriteCreateRole(auth, name, description, permissions);

    return NextResponse.json(newRole);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
