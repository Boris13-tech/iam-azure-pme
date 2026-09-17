import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { requireAuth } from "@/lib/auth/require-auth";
import { resolveLegacyUser } from "@/lib/auth/legacy-auth-adapter";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth();
    
    // We only want to show dashboard data for legacy users within the same organization
    const activeUsersCount = await rawPrisma.legacyUserBridge.count({
      where: {
        organizationId: auth.organizationId,
        status: "VALIDATED",
        legacyUser: { status: "ACTIVE" }
      }
    });

    const rolesCount = await rawPrisma.role.count();

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const logs = await rawPrisma.auditLog.findMany({
      where: {
        timestamp: { gte: thirtyDaysAgo },
        actor: {
          migrationBridge: {
            organizationId: auth.organizationId,
            status: "VALIDATED"
          }
        }
      },
      orderBy: { timestamp: 'asc' }
    });

    const loginsByDay: Record<string, number> = {};
    
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayStr = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
      loginsByDay[dayStr] = 0;
    }

    logs.forEach(log => {
      const d = log.timestamp;
      const dayStr = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
      if (loginsByDay[dayStr] !== undefined) {
        loginsByDay[dayStr]++;
      } else {
        loginsByDay[dayStr] = 1;
      }
    });

    const graphData = Object.entries(loginsByDay).map(([name, logins]) => ({
      name,
      logins
    })).slice(-7);

    return NextResponse.json({
      activeUsers: activeUsersCount,
      rolesConfigured: rolesCount,
      graphData
    });
  } catch (error: any) {
    if (error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Dashboard API Error:", error);
    return NextResponse.json({ error: "Failed to fetch dashboard data" }, { status: 500 });
  }
}