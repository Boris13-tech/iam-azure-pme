import { NextResponse } from "next/server";
import { requireAuth } from "../../../lib/auth/require-auth";
import { withTenantDb } from "../../../lib/db/scoped-client";
import { loadPlatformContext } from "../../../lib/platform/context";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await requireAuth();
    const platform = await loadPlatformContext(auth);
    const can = (key: string) => platform.entitlements.includes(key);
    const data = await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async tx => {
      const [activeUsers, activeSessions, protectedResources, providerScopes, assignments, auditEvents] = await Promise.all([
        can("subjects.read") ? tx.subject.count({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, type: "HUMAN", lifecycleState: "ACTIVE" } }) : null,
        can("sessions.read") ? tx.session.count({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, revokedAt: null, expiresAt: { gt: new Date() } } }) : null,
        can("resources.read") ? tx.resource.count({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, active: true } }) : null,
        can("providers.read") ? tx.providerConnectionTenantScope.count({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId } }) : null,
        can("assignments.read") ? tx.assignment.findMany({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, status: "ACTIVE", entitlement: { active: true }, OR: [{ validFrom: null }, { validFrom: { lte: new Date() } }], AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] }] }, select: { sourceRef: true } }) : null,
        can("audit.read") ? tx.canonicalAdminAuditEvent.findMany({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId }, orderBy: { occurredAt: "desc" }, take: 20, select: { id: true, operation: true, result: true, occurredAt: true } }) : [],
      ]);
      return { activeUsers, activeSessions, protectedResources, providerScopes, rolesConfigured: assignments === null ? null : new Set(assignments.map(row => row.sourceRef).filter(Boolean)).size, entitlements: platform.entitlements, recentEvents: auditEvents };
    });
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    console.error("DASHBOARD_CANONICAL_READ_FAILED");
    return NextResponse.json({ error: "Dashboard unavailable" }, { status: 503 });
  }
}
