import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { requireAuth } from "@/lib/auth/require-auth";
import { checkPermission } from "@/lib/auth/authorization-gateway";
import { dualWriteUpdateRolePermissions, dualWriteDeleteRole } from "@/lib/auth/dual-write-service";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireAuth();

    const allowed = await checkPermission(auth, { action: "manage", resource: "roles" });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const { name, description, permissions } = body;

    const role = await dualWriteUpdateRolePermissions(auth, id, name, description, permissions);

    return NextResponse.json(role);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireAuth();

    const allowed = await checkPermission(auth, { action: "manage", resource: "roles" });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const role = await rawPrisma.role.findUnique({ where: { id: id } });
    if (!role || !role.isCustom) {
      return NextResponse.json({ error: "Cannot delete built-in roles" }, { status: 400 });
    }

    await dualWriteDeleteRole(auth, id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}