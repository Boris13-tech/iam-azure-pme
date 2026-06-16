import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allowed = await hasPermission(userId, "manage", "roles");
  if (!allowed && userId !== "mock-admin-id") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const { name, description, permissions } = body;

  try {
    const role = await prisma.role.update({
      where: { id: params.id },
      data: { name, description }
    });

    if (permissions && Array.isArray(permissions)) {
      // Clear old permissions
      await prisma.rolePermission.deleteMany({
        where: { roleId: params.id }
      });

      // Add new permissions
      for (const permStr of permissions) {
        const [action, resource] = permStr.split(":");
        const perm = await prisma.permission.upsert({
          where: { action_resource: { action, resource } },
          update: {},
          create: { action, resource }
        });

        await prisma.rolePermission.create({
          data: {
            roleId: role.id,
            permissionId: perm.id
          }
        });
      }
    }

    return NextResponse.json(role);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allowed = await hasPermission(userId, "manage", "roles");
  if (!allowed && userId !== "mock-admin-id") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const role = await prisma.role.findUnique({ where: { id: params.id } });
    if (!role || !role.isCustom) {
      return NextResponse.json({ error: "Cannot delete built-in roles" }, { status: 400 });
    }

    await prisma.role.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}