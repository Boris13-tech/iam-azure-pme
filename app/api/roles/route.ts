import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { requireAuth } from "@/lib/auth/require-auth";
import { hasLegacyPermission } from "@/lib/auth/legacy-auth-adapter";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth();

    const allowed = await hasLegacyPermission(auth, "read", "roles");
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

    const allowed = await hasLegacyPermission(auth, "manage", "roles");
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const { name, description, permissions } = body;

    const newRole = await rawPrisma.role.create({
      data: {
        name,
        description,
        isCustom: true
      }
    });

    if (permissions && Array.isArray(permissions)) {
      for (const permStr of permissions) {
        const [action, resource] = permStr.split(":");
        const perm = await rawPrisma.permission.upsert({
          where: { action_resource: { action, resource } },
          update: {},
          create: { action, resource }
        });

        await rawPrisma.rolePermission.create({
          data: {
            roleId: newRole.id,
            permissionId: perm.id
          }
        });
      }
    }

    return NextResponse.json(newRole);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}