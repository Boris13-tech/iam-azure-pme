import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { updateAzureUserStatus, updateAzureUser } from "@/lib/graph";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allowed = await hasPermission(userId, "update", "users");
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  
  try {
    const userToUpdate = await prisma.user.findUnique({ where: { id: params.id } });
    if (!userToUpdate) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (userToUpdate.id === userId && body.status === "SUSPENDED") {
      return NextResponse.json({ error: "Cannot suspend yourself" }, { status: 400 });
    }

    const updatedUser = await prisma.user.update({
      where: { id: params.id },
      data: {
        status: body.status,
        name: body.name,
      }
    });

    // Update in Azure AD
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
      // Clean up other roles first or upsert
      await prisma.userRole.deleteMany({
        where: { userId: params.id }
      });
      
      await prisma.userRole.create({
        data: { userId: params.id, roleId: body.roleId },
      });
    }

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "UPDATE_USER",
        target: params.id,
        ip: req.headers.get("x-forwarded-for") || "unknown",
        result: "SUCCESS"
      }
    });

    return NextResponse.json(updatedUser);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allowed = await hasPermission(userId, "delete", "users");
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (params.id === userId) {
    return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
  }

  try {
    const deletedUser = await prisma.user.update({
      where: { id: params.id },
      data: { status: "INACTIVE" }
    });

    // Update in Azure AD (deactivate account)
    const hasGraphConfig = 
      (process.env.GRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_GRAPH_CLIENT_ID) && 
      process.env.GRAPH_CLIENT_SECRET && 
      process.env.GRAPH_CLIENT_SECRET !== "dummy_secret_to_prevent_build_crash";

    if (deletedUser.azureId && hasGraphConfig) {
      await updateAzureUserStatus(deletedUser.azureId, false);
    }

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "SOFT_DELETE_USER",
        target: params.id,
        ip: req.headers.get("x-forwarded-for") || "unknown",
        result: "SUCCESS"
      }
    });

    return NextResponse.json({ success: true, user: deletedUser });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
