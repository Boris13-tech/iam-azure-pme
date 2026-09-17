import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { requireAuth } from "@/lib/auth/require-auth";
import { hasLegacyPermission } from "@/lib/auth/legacy-auth-adapter";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const auth = await requireAuth();

    const allowed = await hasLegacyPermission(auth, "manage", "roles");
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const { name, description, permissions } = body;

    const role = await rawPrisma.role.update({
      where: { id: params.id },
      data: { name, description }
    });

    if (permissions && Array.isArray(permissions)) {
      // Clear old permissions
      await rawPrisma.rolePermission.deleteMany({
        where: { roleId: params.id }
      });

      // Add new permissions
      for (const permStr of permissions) {
        const [action, resource] = permStr.split(":");
        const perm = await rawPrisma.permission.upsert({
          where: { action_resource: { action, resource } },
          update: {},
          create: { action, resource }
        });

        await rawPrisma.rolePermission.create({
          data: {
            roleId: role.id,
            permissionId: perm.id
          }
        });
      }
    }

    return NextResponse.json(role);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const auth = await requireAuth();

    const allowed = await hasLegacyPermission(auth, "manage", "roles");
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const role = await rawPrisma.role.findUnique({ where: { id: params.id } });
    if (!role || !role.isCustom) {
      return NextResponse.json({ error: "Cannot delete built-in roles" }, { status: 400 });
    }

    await rawPrisma.role.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}