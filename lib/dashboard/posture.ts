// Enterprise Identity Security Dashboard v1 orchestrator.
// 1) Viewer gate + native entitlements + one DASHBOARD.POSTURE.READ audit event (decision D1).
// 2) All widgets in ONE read-only RLS transaction; restricted widgets are never queried;
//    a failing widget is isolated by a savepoint and reported as "unavailable", never as 0.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AuthContext } from "../auth/auth-context";
import { CanonicalAdminError } from "../admin/canonical-administration";
import { rawPrisma } from "../db/raw-prisma";
import { withTenantDb } from "../db/scoped-client";
import {
  SECTION_ORDER, WIDGETS, WIDGET_IDS, attentionCount, isPermitted,
  type PostureResponse, type SectionId, type Widget, type WidgetId,
} from "./posture-contract";
import { POSTURE_QUERIES, Since, Unavailable, type PostureQueries } from "./posture-queries";

export const POSTURE_AUDIT_OPERATION = "DASHBOARD.POSTURE.READ";
const STATEMENT_TIMEOUT_MS = 5_000;

/** Same semantics as requireNative: ACTIVE viewer, effective, non-legacy, global (non resource-scoped) grants. */
async function viewerEntitlements(tx: Prisma.TransactionClient, auth: AuthContext, now: Date): Promise<Set<string>> {
  const scope = { organizationId: auth.organizationId, tenantId: auth.tenantId };
  const viewer = await tx.subject.findFirst({ where: { ...scope, id: auth.subjectId, lifecycleState: "ACTIVE" }, select: { id: true } });
  if (!viewer) throw new CanonicalAdminError("FORBIDDEN", 403);
  const rows = await tx.assignment.findMany({ where: { ...scope, subjectId: auth.subjectId, status: "ACTIVE", source: { not: "LEGACY_ROLE" },
    OR: [{ validFrom: null }, { validFrom: { lte: now } }],
    AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: now } }] }],
    entitlement: { active: true, resourceScopeId: null } }, select: { entitlement: { select: { key: true } } } });
  return new Set(rows.map(r => r.entitlement.key));
}

/** Read-only tenant transaction. SET TRANSACTION must precede any statement, hence not withTenantDb. */
function withReadOnlyTenantDb<T>(scope: { organizationId: string; tenantId: string }, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return rawPrisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$queryRaw`SELECT set_config('app.organization_id', ${scope.organizationId}, true)`;
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${scope.tenantId}, true)`;
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return work(tx);
  }, { maxWait: 10_000, timeout: 30_000 });
}

export type PostureOptions = Readonly<{ now?: Date; queries?: Partial<PostureQueries> }>;

export async function loadIdentitySecurityPosture(auth: AuthContext, options: PostureOptions = {}): Promise<PostureResponse> {
  const now = options.now ?? new Date();
  const queries = { ...POSTURE_QUERIES, ...options.queries } as PostureQueries;
  const scope = { organizationId: auth.organizationId, tenantId: auth.tenantId };

  const { held, organization, tenant } = await withTenantDb(scope, async tx => {
    const held = await viewerEntitlements(tx, auth, now);
    const [organization, tenant] = await Promise.all([
      tx.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { id: true, name: true } }),
      tx.tenant.findUniqueOrThrow({ where: { organizationId_id: { organizationId: auth.organizationId, id: auth.tenantId } }, select: { id: true, name: true } }),
    ]);
    const visible = WIDGET_IDS.filter(id => isPermitted(id, held)).length;
    await tx.canonicalAdminAuditEvent.create({ data: { ...scope, actorSubjectId: auth.subjectId, operation: POSTURE_AUDIT_OPERATION,
      changeId: `read:dashboard.posture:${randomUUID()}`, result: "SUCCESS",
      metadata: { contractVersion: 1, visibleWidgets: visible, restrictedWidgets: WIDGET_IDS.length - visible } } });
    return { held, organization, tenant };
  });

  const widgets = await withReadOnlyTenantDb(scope, async tx => {
    const out: Widget[] = [];
    for (const id of WIDGET_IDS) {
      const def = WIDGETS[id] as (typeof WIDGETS)[WidgetId] & { reason?: string };
      if (!isPermitted(id, held)) { out.push({ id, state: "restricted" }); continue; }
      if (def.kind === "not_implemented") { out.push({ id, state: "not_implemented", reason: def.reason! }); continue; }
      await tx.$executeRawUnsafe("SAVEPOINT posture_widget");
      try {
        const value = await queries[id as keyof PostureQueries]({ tx, scope, viewerSubjectId: auth.subjectId, now });
        await tx.$executeRawUnsafe("RELEASE SAVEPOINT posture_widget");
        if (value instanceof Unavailable) out.push({ id, state: "unavailable", reason: value.reason });
        else if (value instanceof Since) out.push({ id, state: "ok", value: value.value, since: value.since });
        else out.push({ id, state: "ok", value });
      } catch {
        // No raw diagnostics: the error never reaches the response or logs.
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT posture_widget");
        out.push({ id, state: "unavailable", reason: "QUERY_FAILED" });
      }
    }
    return out;
  });

  const sections = Object.fromEntries(SECTION_ORDER.map(s => [s, widgets.filter(w => WIDGETS[w.id].section === s)])) as Record<SectionId, Widget[]>;
  const attention = widgets.flatMap(w => { const count = attentionCount(w);
    return count && count > 0 ? [{ id: w.id, count, section: WIDGETS[w.id].section as SectionId }] : []; });
  return { contractVersion: 1, asOf: now.toISOString(), organization, tenant, sections, attention };
}
