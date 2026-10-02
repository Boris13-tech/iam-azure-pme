import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { requireAuth } from "@/lib/auth/require-auth";
import { checkPermission } from "@/lib/auth/authorization-gateway";
import { resolveLegacyUser } from "@/lib/auth/legacy-auth-adapter";
import { dualWriteUpdateUserRole } from "@/lib/auth/dual-write-service";

import { hasMicrosoftGraphConfiguration, updateAzureUserStatus, updateAzureUser } from "@/lib/graph";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireAuth();

    const allowed = await checkPermission(auth, { action: "update", resource: "users" });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const legacyUser = await resolveLegacyUser(auth);
    if (!legacyUser) return NextResponse.json({ error: "Forbidden - No legacy mapping" }, { status: 403 });

    const body = await req.json();

    const bridge = await rawPrisma.legacyUserBridge.findFirst({
      where: {
        legacyUserId: id,
        organizationId: auth.organizationId,
        status: "VALIDATED"
      }
    });

    if (!bridge) return NextResponse.json({ error: "Not found or not in this organization" }, { status: 404 });

    if (id === legacyUser.id && body.status === "SUSPENDED") {
      return NextResponse.json({ error: "Cannot suspend yourself" }, { status: 400 });
    }

    const updatedUser = await rawPrisma.user.update({
      where: { id: id },
      data: {
        status: body.status,
        name: body.name,
      }
    });

    const hasGraphConfig = hasMicrosoftGraphConfiguration();

    if (updatedUser.azureId && hasGraphConfig) {
      if (body.status !== undefined) {
        await updateAzureUserStatus(auth, updatedUser.azureId, body.status === "ACTIVE");
      }
      if (body.name !== undefined) {
        await updateAzureUser(auth, updatedUser.azureId, body.name);
      }
    }

    if (body.roleId) {
      await dualWriteUpdateUserRole(auth, id, body.roleId);
    }

    await rawPrisma.auditLog.create({
      data: {
        actorId: legacyUser.id,
        action: "UPDATE_USER",
        target: id,
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

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const auth = await requireAuth();

    const allowed = await checkPermission(auth, { action: "delete", resource: "users" });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const legacyUser = await resolveLegacyUser(auth);
    if (!legacyUser) return NextResponse.json({ error: "Forbidden - No legacy mapping" }, { status: 403 });

    if (id === legacyUser.id) {
      return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
    }

    const bridge = await rawPrisma.legacyUserBridge.findFirst({
      where: {
        legacyUserId: id,
        organizationId: auth.organizationId,
        status: "VALIDATED"
      }
    });

    if (!bridge) return NextResponse.json({ error: "Not found or not in this organization" }, { status: 404 });

    const deletedUser = await rawPrisma.user.update({
      where: { id: id },
      data: { status: "INACTIVE" }
    });

    const hasGraphConfig = hasMicrosoftGraphConfiguration();

    if (deletedUser.azureId && hasGraphConfig) {
      await updateAzureUserStatus(auth, deletedUser.azureId, false);
    }

    await rawPrisma.auditLog.create({
      data: {
        actorId: legacyUser.id,
        action: "SOFT_DELETE_USER",
        target: id,
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
