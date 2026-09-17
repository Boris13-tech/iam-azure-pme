import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { requireAuth } from "@/lib/auth/require-auth";
import { hasLegacyPermission } from "@/lib/auth/legacy-auth-adapter";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth();

    let policy = await rawPrisma.accessPolicy.findUnique({
      where: { id: "global" }
    });

    if (!policy) {
      policy = await rawPrisma.accessPolicy.create({
        data: { id: "global" }
      });
    }

    return NextResponse.json(policy);
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await requireAuth();
    // Temporarily disable mutations since AccessPolicy is not yet tenant-aware
    return NextResponse.json({ error: "Mutating global access policies is disabled in this Phase until they are scoped by Organization." }, { status: 403 });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}