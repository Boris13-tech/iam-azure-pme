import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allowed = await hasPermission(userId, "read", "audit");
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const skip = parseInt(searchParams.get("skip") || "0");
  const take = parseInt(searchParams.get("take") || "50");

  const logs = await prisma.auditLog.findMany({
    skip,
    take,
    orderBy: { timestamp: "desc" },
    include: { actor: { select: { name: true, email: true } } }
  });

  return NextResponse.json(logs);
}