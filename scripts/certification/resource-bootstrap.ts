// Operator-only clone ceremony. Never import from application routes or services.
import { createHash } from "node:crypto";
import { withTenantDb } from "../../lib/db/scoped-client";
import { internalBinding } from "../../lib/resources/onboarding";
import { evaluateSoD } from "../../lib/resources/sod";
import { APPROVED_BYTES, APPROVED_DIGEST, APPROVAL, MANIFEST as m } from "./resource-bootstrap-manifest";

export const auth = { organizationId: m.organizationId, tenantId: m.tenantId, subjectId: m.actorSubjectId };
const context = { organizationId: m.organizationId, tenantId: m.tenantId };
const changeId = `bootstrap:${m.operationId}`;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export function assertCloneEndpoint() {
  const url = new URL(process.env.DATABASE_URL ?? "http://missing");
  if (url.protocol !== "postgresql:" || url.hostname !== "ep-delicate-bar-ahz7cosb-pooler.c-3.us-east-1.aws.neon.tech" ||
      url.pathname !== "/neondb" || url.username !== "app_user" || process.env.LUXIA_BOOTSTRAP_BRANCH !== m.branch ||
      process.env.LUXIA_BOOTSTRAP_ENVIRONMENT !== "CERTIFICATION_ONLY") throw new Error("EXACT_CERTIFICATION_CLONE_REQUIRED");
}

export function exactApproval(bytes: string) {
  return bytes === APPROVED_BYTES && digest(bytes) === APPROVED_DIGEST && APPROVAL.manifestBinding === APPROVED_DIGEST &&
    m.environment === "CERTIFICATION_ONLY" && m.database === "neondb" &&
    Date.parse(m.validUntil) - Date.parse(m.validFrom) === 3_600_000 && Date.parse(APPROVAL.approvedAt) <= Date.parse(m.validFrom);
}

async function ceremony(bytes: string, revoke: boolean) {
  assertCloneEndpoint(); // BEFORE any query; environment label alone never authorizes a host.
  return withTenantDb(auth, async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${m.organizationId}:${m.tenantId}`},0))::text`;
    const roles = await tx.$queryRaw<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean; database: string }>>`
      SELECT current_user,rolsuper,rolbypassrls,current_database() AS database FROM pg_roles WHERE rolname=current_user`;
    if (roles[0]?.current_user !== "app_user" || roles[0].rolsuper || roles[0].rolbypassrls || roles[0].database !== "neondb")
      throw new Error("RUNTIME_POSTURE_INVALID");
    const posture = await tx.$queryRaw<Array<{ owned: number; forced: number }>>`
      SELECT (SELECT count(*)::int FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        AND relnamespace='public'::regnamespace) AS owned,
        (SELECT count(*)::int FROM pg_class WHERE relname IN ('Subject','Assignment','Entitlement','Resource','ResourceScope','CanonicalAdminAuditEvent')
          AND relnamespace='public'::regnamespace AND relrowsecurity AND relforcerowsecurity) AS forced`;
    if (posture[0]?.owned !== 0 || posture[0]?.forced !== 6) throw new Error("CLONE_RLS_POSTURE_INVALID");
    const reject = async (reasonCode: string) => {
      const deniedChange = `${changeId}:denied:${digest(bytes)}:${reasonCode}`;
      if (!await tx.canonicalAdminAuditEvent.findFirst({ where: { ...context, changeId: deniedChange } }))
        await tx.canonicalAdminAuditEvent.create({ data: { ...context, actorSubjectId: m.actorSubjectId,
          targetSubjectId: m.targetSubjectId, operation: "RESOURCE.ONBOARDING.BOOTSTRAP.DENIED", result: "DENIED",
          changeId: deniedChange, metadata: { reasonCode, manifestBinding: APPROVED_DIGEST } } });
      return { outcome: "DENIED" as const, reasonCode };
    };
    if (!exactApproval(bytes)) return reject("MANIFEST_OR_APPROVAL_MISMATCH");
    const prior = await tx.canonicalAdminAuditEvent.findFirst({ where: { ...context, changeId } });
    const assignment = await tx.assignment.findFirst({ where: { ...context, id: m.assignmentId } });
    if (prior && (prior.operation !== "RESOURCE.ONBOARDING.BOOTSTRAP" || prior.result !== "SUCCESS" ||
        prior.actorSubjectId !== m.actorSubjectId || prior.targetSubjectId !== m.targetSubjectId ||
        prior.assignmentIds.length !== 1 || prior.assignmentIds[0] !== m.assignmentId ||
        (prior.metadata as { manifestBinding?: string } | null)?.manifestBinding !== APPROVED_DIGEST))
      return reject("BOOTSTRAP_RECEIPT_CONFLICT");
    if (revoke) {
      if (!prior || !assignment || assignment.entitlementId !== m.entitlementId || assignment.subjectId !== m.targetSubjectId ||
          assignment.source !== "DIRECT" || assignment.sourceRef !== changeId) return reject("BOOTSTRAP_RECEIPT_MISSING");
      const revokeId = `${changeId}:revoke`;
      if (assignment.status === "REVOKED") return { outcome: "REVOKED" as const, replay: true };
      // Operator rollback only; normal self-revoke protections remain unchanged.
      await tx.assignment.update({ where: { id: m.assignmentId }, data: { status: "REVOKED" } });
      await tx.canonicalAdminAuditEvent.create({ data: { ...context, actorSubjectId: m.actorSubjectId, targetSubjectId: m.targetSubjectId,
        operation: "RESOURCE.ONBOARDING.BOOTSTRAP.REVOKE", result: "SUCCESS", changeId: revokeId,
        assignmentIds: [m.assignmentId], metadata: { manifestBinding: APPROVED_DIGEST, operationId: m.operationId } } });
      return { outcome: "REVOKED" as const, replay: false };
    }
    if (prior) {
      if (!assignment || assignment.status !== "ACTIVE" || !assignment.validUntil || assignment.validUntil.getTime() <= Date.now())
        return reject("BOOTSTRAP_ALREADY_REVOKED_OR_EXPIRED");
      if (assignment.subjectId !== m.targetSubjectId || assignment.entitlementId !== m.entitlementId || assignment.source !== "DIRECT" ||
          assignment.sourceRef !== changeId || assignment.validFrom?.toISOString() !== m.validFrom.replace("Z", ".000Z") ||
          assignment.validUntil.toISOString() !== m.validUntil.replace("Z", ".000Z")) return reject("BOOTSTRAP_RECEIPT_CONFLICT");
    }
    const now = Date.now();
    if (now < Date.parse(m.validFrom) || now >= Date.parse(m.validUntil)) return reject("APPROVAL_WINDOW_CLOSED");
    if (!await tx.subject.findFirst({ where: { ...context, id: m.targetSubjectId, lifecycleState: "ACTIVE" } }))
      return reject("SUBJECT_NOT_ACTIVE");
    if (!await internalBinding(tx, auth)) return reject("RESOURCE_BINDING_MISMATCH");
    const sod = await evaluateSoD(tx, { ...context, subjectId: m.targetSubjectId, entitlementId: m.entitlementId,
      resourceId: m.resourceId, scope: m.scopeId, assignmentOperation: "CREATE", validFrom: new Date(m.validFrom), validUntil: new Date(m.validUntil) });
    if (sod.decision !== "ALLOW") return reject("SOD_CONFLICT");
    if (prior) return { outcome: "ALREADY_APPLIED" as const, assignmentId: m.assignmentId };
    if (assignment || await tx.assignment.count({ where: { ...context, entitlementId: m.entitlementId } }))
      return reject("INITIAL_BOOTSTRAP_COLLISION");
    await tx.assignment.create({ data: { ...context, id: m.assignmentId, subjectId: m.targetSubjectId,
      entitlementId: m.entitlementId, source: "DIRECT", sourceRef: changeId, status: "ACTIVE",
      validFrom: new Date(m.validFrom), validUntil: new Date(m.validUntil) } });
    await tx.canonicalAdminAuditEvent.create({ data: { ...context, actorSubjectId: m.actorSubjectId, targetSubjectId: m.targetSubjectId,
      operation: "RESOURCE.ONBOARDING.BOOTSTRAP", result: "SUCCESS", changeId, assignmentIds: [m.assignmentId],
      metadata: { manifestBinding: APPROVED_DIGEST, operationId: m.operationId, scopeId: m.scopeId, resourceId: m.resourceId,
        entitlementId: m.entitlementId, action: m.action, validFrom: m.validFrom, validUntil: m.validUntil,
        approval: APPROVAL } } });
    return { outcome: "CREATED" as const, assignmentId: m.assignmentId };
  }); // Denial is a committed sentinel, not a throw inside the transaction.
}
export const bootstrap = (bytes = APPROVED_BYTES) => ceremony(bytes, false);
export const revokeBootstrap = () => ceremony(APPROVED_BYTES, true);
