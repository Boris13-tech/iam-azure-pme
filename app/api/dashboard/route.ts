import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { withTenantDb } from "@/lib/db/scoped-client";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await requireAuth();
    const data = await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async tx => {
      const [activeUsers, activeSessions, protectedResources, providerScopes, assignments, auditEvents] = await Promise.all([
        tx.subject.count({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, type: "HUMAN", lifecycleState: "ACTIVE" } }),
        tx.session.count({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, revokedAt: null, expiresAt: { gt: new Date() } } }),
        tx.resource.count({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId } }),
        tx.providerConnectionTenantScope.count({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId } }),
        tx.assignment.findMany({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, status: "ACTIVE" }, select: { sourceRef: true } }),
        tx.canonicalAdminAuditEvent.findMany({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, occurredAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, select: { occurredAt: true } }),
      ]);
      const daily = new Map<string, number>();
      for (let offset = 6; offset >= 0; offset--) { const date = new Date(Date.now() - offset * 86_400_000); daily.set(`${String(date.getDate()).padStart(2,"0")}/${String(date.getMonth()+1).padStart(2,"0")}`, 0); }
      for (const event of auditEvents) { const key = `${String(event.occurredAt.getDate()).padStart(2,"0")}/${String(event.occurredAt.getMonth()+1).padStart(2,"0")}`; if (daily.has(key)) daily.set(key, (daily.get(key) ?? 0) + 1); }
      return { activeUsers, activeSessions, protectedResources, providerScopes, rolesConfigured: new Set(assignments.map(row => row.sourceRef).filter(Boolean)).size, graphData: [...daily].map(([name, events]) => ({ name, events })) };
    });
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    console.error("DASHBOARD_CANONICAL_READ_FAILED");
    return NextResponse.json({ error: "Dashboard unavailable" }, { status: 503 });
  }
}
