import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { syncAzureUsers, createAzureUser } from "@/lib/graph";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allowed = await hasPermission(userId, "read", "users");
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const hasGraphConfig = 
    (process.env.GRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_GRAPH_CLIENT_ID) && 
    process.env.GRAPH_CLIENT_SECRET && 
    process.env.GRAPH_CLIENT_SECRET !== "dummy_secret_to_prevent_build_crash";

  if (hasGraphConfig) {
    await syncAzureUsers();
  }

  const { searchParams } = new URL(req.url);
  const skip = parseInt(searchParams.get("skip") || "0");
  const take = parseInt(searchParams.get("take") || "10");

  const users = await prisma.user.findMany({
    skip,
    take,
    include: { roles: { include: { role: true } } },
    orderBy: { createdAt: "desc" },
  });

  const total = await prisma.user.count();

  return NextResponse.json({ users, total });
}

export async function POST(req: Request) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allowed = await hasPermission(userId, "create", "users");
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  
  try {
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

    const newUser = await prisma.user.create({
      data: {
        email: body.email,
        name: body.name,
        azureId: azureId,
        status: "ACTIVE",
      }
    });

    if (body.roleId) {
      try {
        await prisma.userRole.create({
          data: {
            userId: newUser.id,
            roleId: body.roleId
          }
        });
      } catch (e) {
        console.warn("Role assignment failed", e);
      }
    }

    await prisma.auditLog.create({
      data: {
        actorId: userId,
        action: "CREATE_USER",
        target: newUser.id,
        ip: req.headers.get("x-forwarded-for") || "unknown",
        result: "SUCCESS"
      }
    });

    return NextResponse.json(newUser);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
