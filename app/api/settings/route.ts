import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    let policy = await prisma.accessPolicy.findUnique({
      where: { id: "global" }
    });

    if (!policy) {
      policy = await prisma.accessPolicy.create({
        data: { id: "global" }
      });
    }

    return NextResponse.json(policy);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Only admins can change policies (or mock admin)
  const allowed = await hasPermission(userId, "manage", "settings");
  if (!allowed && userId !== "mock-admin-id") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const { mfa, geoBlock, sessionTimeout, passwordRotation } = body;

  try {
    const policy = await prisma.accessPolicy.upsert({
      where: { id: "global" },
      update: { mfa, geoBlock, sessionTimeout, passwordRotation },
      create: { id: "global", mfa, geoBlock, sessionTimeout, passwordRotation }
    });

    return NextResponse.json(policy);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}