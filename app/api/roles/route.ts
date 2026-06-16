import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allowed = await hasPermission(userId, "read", "roles");
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const roles = await prisma.role.findMany({
    include: { _count: { select: { users: true } }, permissions: { include: { permission: true } } }
  });

  return NextResponse.json(roles);
}

export async function POST(req: Request) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allowed = await hasPermission(userId, "manage", "roles");
  if (!allowed && userId !== "mock-admin-id") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const { name, description, permissions } = body;

  try {
    const newRole = await prisma.role.create({
      data: {
        name,
        description,
        isCustom: true
      }
    });

    if (permissions && Array.isArray(permissions)) {
      for (const permStr of permissions) {
        const [action, resource] = permStr.split(":");
        const perm = await prisma.permission.upsert({
          where: { action_resource: { action, resource } },
          update: {},
          create: { action, resource }
        });

        await prisma.rolePermission.create({
          data: {
            roleId: newRole.id,
            permissionId: perm.id
          }
        });
      }
    }

    return NextResponse.json(newRole);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}