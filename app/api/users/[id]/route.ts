import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { requireAuth } from "@/lib/auth/require-auth";
import { checkPermission } from "@/lib/auth/authorization-gateway";
import { resolveLegacyUser } from "@/lib/auth/legacy-auth-adapter";

import { updateAzureUserStatus, updateAzureUser } from "@/lib/graph";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const auth = await requireAuth();

    const allowed = await checkPermission(auth, { action: "update", resource: "users" });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const legacyUser = await resolveLegacyUser(auth);
    if (!legacyUser) return NextResponse.json({ error: "Forbidden - No legacy mapping" }, { status: 403 });

    const body = await req.json();

    const bridge = await rawPrisma.legacyUserBridge.findFirst({
      where: {
        legacyUserId: params.id,
        organizationId: auth.organizationId,
        status: "VALIDATED"
      }
    });

    if (!bridge) return NextResponse.json({ error: "Not found or not in this organization" }, { status: 404 });

    if (params.id === legacyUser.id && body.status === "SUSPENDED") {
      return NextResponse.json({ error: "Cannot suspend yourself" }, { status: 400 });
    }

    const updatedUser = await rawPrisma.user.update({
      where: { id: params.id },
      data: {
        status: body.status,
        name: body.name,
      }
    });

    const hasGraphConfig = 
      (process.env.GRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_GRAPH_CLIENT_ID) && 
      process.env.GRAPH_CLIENT_SECRET && 
      process.env.GRAPH_CLIENT_SECRET !== "dummy_secret_to_prevent_build_crash";

    if (updatedUser.azureId && hasGraphConfig) {
      if (body.status !== undefined) {
        await updateAzureUserStatus(updatedUser.azureId, body.status === "ACTIVE");
      }
      if (body.name !== undefined) {
        await updateAzureUser(updatedUser.azureId, body.name);
      }
    }

    if (body.roleId) {
      await rawPrisma.userRole.deleteMany({
        where: { userId: params.id }
      });
      
      await rawPrisma.userRole.create({
        data: { userId: params.id, roleId: body.roleId },
      });
    }

    await rawPrisma.auditLog.create({
      data: {
        actorId: legacyUser.id,
        action: "UPDATE_USER",
        target: params.id,
        ip: req.headers.get("x-forwarded-for") || "unknown",
        result: "SUCCESS"
      }
    });

    return NextResponse.json(updatedUser);
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

    const allowed = await checkPermission(auth, { action: "delete", resource: "users" });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const legacyUser = await resolveLegacyUser(auth);
    if (!legacyUser) return NextResponse.json({ error: "Forbidden - No legacy mapping" }, { status: 403 });

    if (params.id === legacyUser.id) {
      return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
    }

    const bridge = await rawPrisma.legacyUserBridge.findFirst({
      where: {
        legacyUserId: params.id,
        organizationId: auth.organizationId,
        status: "VALIDATED"
      }
    });

    if (!bridge) return NextResponse.json({ error: "Not found or not in this organization" }, { status: 404 });

    const deletedUser = await rawPrisma.user.update({
      where: { id: params.id },
      data: { status: "INACTIVE" }
    });

    const hasGraphConfig = 
      (process.env.GRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_GRAPH_CLIENT_ID) && 
      process.env.GRAPH_CLIENT_SECRET && 
      process.env.GRAPH_CLIENT_SECRET !== "dummy_secret_to_prevent_build_crash";

    if (deletedUser.azureId && hasGraphConfig) {
      await updateAzureUserStatus(deletedUser.azureId, false);
    }

    await rawPrisma.auditLog.create({
      data: {
        actorId: legacyUser.id,
        action: "SOFT_DELETE_USER",
        target: params.id,
        ip: req.headers.get("x-forwarded-for") || "unknown",
        result: "SUCCESS"
      }
    });

    return NextResponse.json({ success: true, user: deletedUser });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
