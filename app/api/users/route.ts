import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { requireAuth } from "@/lib/auth/require-auth";
import { checkPermission } from "@/lib/auth/authorization-gateway";
import { resolveLegacyUser } from "@/lib/auth/legacy-auth-adapter";
import { dualWriteUpdateUserRole } from "@/lib/auth/dual-write-service";
import { createAzureUser } from "@/lib/graph";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth();

    const allowed = await checkPermission(auth, { action: "read", resource: "users" });
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const skip = parseInt(searchParams.get("skip") || "0");
    const take = parseInt(searchParams.get("take") || "10");

    const bridges = await rawPrisma.legacyUserBridge.findMany({
      skip,
      take,
      where: {
        organizationId: auth.organizationId,
        status: "VALIDATED"
      },
      include: {
        legacyUser: {
          include: { roles: { include: { role: true } } }
        }
      },
      orderBy: { legacyUser: { createdAt: "desc" } },
    });

    const total = await rawPrisma.legacyUserBridge.count({
      where: {
        organizationId: auth.organizationId,
        status: "VALIDATED"
      }
    });

    const users = bridges.map(b => b.legacyUser).filter(u => u !== null);

    return NextResponse.json({ users, total });
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

    const allowed = await checkPermission(auth, { action: "create", resource: "users" });
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const legacyUser = await resolveLegacyUser(auth);
    if (!legacyUser) return NextResponse.json({ error: "Forbidden - No legacy mapping" }, { status: 403 });

    const body = await req.json();
    let azureId = body.azureId || null;

    const hasGraphConfig = 
      (process.env.GRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_GRAPH_CLIENT_ID) && 
      process.env.GRAPH_CLIENT_SECRET && 
      process.env.GRAPH_CLIENT_SECRET !== "dummy_secret_to_prevent_build_crash";

    if (hasGraphConfig) {
      try {
        const azureUser = await createAzureUser(body.name, body.email);
        azureId = azureUser.azureId;
      } catch (graphError: any) {
        console.error("Failed to create user in Azure AD:", graphError);
        return NextResponse.json({ error: `Erreur Azure AD Graph: ${graphError.message || graphError}` }, { status: 400 });
      }
    }

    const newUser = await rawPrisma.user.create({
      data: {
        email: body.email,
        name: body.name,
        azureId: azureId,
        status: "ACTIVE",
      }
    });

    const newSubject = await rawPrisma.subject.create({
      data: {
        organizationId: auth.organizationId,
        tenantId: auth.tenantId,
        type: "HUMAN",
        name: body.name,
      }
    });

    await rawPrisma.legacyUserBridge.create({
      data: {
        organizationId: auth.organizationId,
        subjectId: newSubject.id,
        legacyUserId: newUser.id,
        status: "VALIDATED"
      }
    });

    if (body.roleId) {
      try {
        await dualWriteUpdateUserRole(auth, newUser.id, body.roleId);
      } catch (e) {
        console.warn("Role assignment failed", e);
      }
    }

    await rawPrisma.auditLog.create({
      data: {
        actorId: legacyUser.id,
        action: "CREATE_USER",
        target: newUser.id,
        ip: req.headers.get("x-forwarded-for") || "unknown",
        result: "SUCCESS"
      }
    });

    return NextResponse.json(newUser);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

