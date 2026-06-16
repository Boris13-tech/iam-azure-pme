import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const activeUsersCount = await prisma.user.count({
      where: { status: "ACTIVE" }
    });

    const rolesCount = await prisma.role.count();

    // Fetch recent audit logs (last 30 days) to build a login graph
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const logs = await prisma.auditLog.findMany({
      where: {
        timestamp: { gte: thirtyDaysAgo }
      },
      orderBy: { timestamp: 'asc' }
    });

    // Group logs by day
    const loginsByDay: Record<string, number> = {};
    
    // Initialize last 7 days with 0
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

    // Format for Recharts
    const graphData = Object.entries(loginsByDay).map(([name, logins]) => ({
      name,
      logins
    })).slice(-7); // take last 7 days for better visualization

    return NextResponse.json({
      activeUsers: activeUsersCount,
      rolesConfigured: rolesCount,
      graphData
    });
  } catch (error: any) {
    console.error("Dashboard API Error:", error);
    return NextResponse.json({ error: "Failed to fetch dashboard data" }, { status: 500 });
  }
}