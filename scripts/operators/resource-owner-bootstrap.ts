// Operator-only. Never import this module from app/ or lib/.
import { createHash } from "node:crypto";
import { z } from "zod";
import { withTenantDb } from "../../lib/db/scoped-client";
import { internalBinding } from "../../lib/resources/onboarding";
import { evaluateSoD } from "../../lib/resources/sod";

export const FIXED = Object.freeze({ projectId: "hidden-leaf-91460552", database: "neondb",
  organizationId: "4841428a-80b4-4f07-bb3f-c94612dfd4a2", tenantId: "c68ae9ee-11a8-42f9-bc9c-b19c42ec7914",
  actorSubjectId: "30a15eda-24d3-40ef-8705-11c2e6e1b929", targetSubjectId: "30a15eda-24d3-40ef-8705-11c2e6e1b929",
  resourceId: "ed8c9111-a930-4724-a76d-bd541538a621", scopeId: "3952f920-c064-46a2-9d22-d31d338c8a54",
  entitlementId: "d6605f22-64f1-467b-b4e4-de806d2c957c", action: "resource.read",
  entitlementKey: "resource-scope:3952f920-c064-46a2-9d22-d31d338c8a54:resource.read" });
export const PROFILES = Object.freeze({
  PRODUCTION: { branch: "br-billowing-frog-ahtirmax", host: "ep-restless-thunder-ah18c37v-pooler.c-3.us-east-1.aws.neon.tech", origin: "https://iam-azure-pme.vercel.app" },
  CERTIFICATION_ONLY: { branch: "br-misty-sun-ahs4b46j", host: "ep-weathered-grass-ah5vrehj-pooler.c-3.us-east-1.aws.neon.tech", origin: "http://localhost:3196" },
});
export const ABANDONED = "95e9b80de3e28890faf01eb41fb70002d6ef1efb6986815da8b8868799376232";
export const hash = (bytes: string) => createHash("sha256").update(bytes, "utf8").digest("hex");
export const VERCEL_PROJECT_ID = "prj_dZ6YOYRdONsicgWdlmofh7NwtoSP";
// This is a separately registered operator artifact, NOT a runtime/environment override.
const releaseSchema = z.object({ releaseVersion: z.literal(1), environment: z.enum(["PRODUCTION", "CERTIFICATION_ONLY"]),
  projectId: z.literal(FIXED.projectId), branch: z.string(), database: z.literal(FIXED.database),
  vercelProjectId: z.literal(VERCEL_PROJECT_ID), deployedSha: z.string().regex(/^[a-f0-9]{40}$/),
  deploymentId: z.string(), manifestBinding: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const manifestSchema = z.object({ manifestVersion: z.literal(1), environment: z.enum(["PRODUCTION", "CERTIFICATION_ONLY"]),
  ...Object.fromEntries(Object.keys(FIXED).map(key => [key, z.string()])), productionDeploymentSha: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string(), scopeType: z.literal("RESOURCE"),
  purpose: z.literal("INITIAL_BOUNDED_RESOURCE_OWNER"), source: z.literal("DIRECT"), assignmentId: z.uuid(), operationId: z.uuid(),
  validFrom: z.iso.datetime(), validUntil: z.iso.datetime(), approvedAt: z.literal("PENDING_EXPLICIT_HUMAN_APPROVAL"),
  approvedBy: z.literal("PENDING_EXPLICIT_HUMAN_APPROVAL"), approvalReference: z.literal("PENDING_EXPLICIT_HUMAN_APPROVAL"),
  requiredResourceBinding: z.literal("EXACT_ACTIVE_RESOURCE_SCOPE_ENTITLEMENT") }).strict();
export type Approval = Readonly<{ manifestBinding: string; releaseBinding: string; approvedAt: string; approvedBy: string; approvalReference: string }>;
// Registry comes from the operator entrypoint, never from a browser/body/admin permission.
export type Registration = Readonly<{ bytes: string; releaseBytes: string; approval: Approval }>;
export type Execution = Readonly<{ mode: keyof typeof PROFILES; url: string; origin: string; deployedSha: string;
  deploymentId: string; verifiedProject: string; verifiedBranch: string; registrations: readonly Registration[] }>;
export function registeredRelease(bytes: string, registrations: readonly Registration[]) {
  const registered = registrations.find(r => r.bytes === bytes);
  if (!registered) throw new Error("OPERATOR_RELEASE_UNREGISTERED");
  return releaseSchema.parse(JSON.parse(registered.releaseBytes));
}
const abandonedIds = new Set(["d19ec5fa-dc0a-4edc-b186-0735d1533c64", "6bb7d556-4920-428b-9ec6-e219c6ff69e0"]);
export function validate(bytes: string, approval: Approval | undefined, execution: Execution, now = Date.now(), cleanup = false) {
  const p = PROFILES[execution.mode];
  if (!p) throw new Error("ENVIRONMENT_DENIED");
  const u = new URL(execution.url);
  if (u.protocol !== "postgresql:" || u.hostname !== p.host || u.username !== "app_user" || u.pathname !== "/neondb" ||
    u.searchParams.get("sslmode") !== "require" || execution.origin !== p.origin || execution.verifiedProject !== FIXED.projectId ||
    execution.verifiedBranch !== p.branch) throw new Error("EXECUTION_BINDING_DENIED");
  const m = manifestSchema.parse(JSON.parse(bytes)) as unknown as typeof FIXED & { productionDeploymentSha: string; environment: keyof typeof PROFILES; branch: string;
    assignmentId: string; operationId: string; validFrom: string; validUntil: string };
  for (const key of Object.keys(FIXED) as (keyof typeof FIXED)[]) if (m[key] !== FIXED[key]) throw new Error("MANIFEST_BINDING_DENIED");
  if (m.environment !== execution.mode || m.branch !== p.branch || hash(bytes) === ABANDONED ||
    abandonedIds.has(m.assignmentId) || abandonedIds.has(m.operationId)) throw new Error("MANIFEST_ABANDONED_OR_WRONG_ENVIRONMENT");
  const registered = execution.registrations.find(r => r.bytes === bytes);
  if (!registered || !approval || hash(bytes) !== approval.manifestBinding || JSON.stringify(registered.approval) !== JSON.stringify(approval) ||
    !approval.approvedBy.trim() || !approval.approvalReference.trim() || !Number.isFinite(Date.parse(approval.approvedAt)) ||
    Date.parse(approval.approvedAt) > now) throw new Error("OPERATOR_APPROVAL_DENIED");
  const release = registeredRelease(bytes, execution.registrations);
  if (hash(registered.releaseBytes) !== approval.releaseBinding || release.manifestBinding !== hash(bytes) ||
    release.environment !== execution.mode || release.branch !== p.branch ||
    release.deployedSha !== m.productionDeploymentSha || release.deployedSha !== execution.deployedSha ||
    release.deploymentId !== execution.deploymentId || (execution.mode === "PRODUCTION"
      ? !/^dpl_[A-Za-z0-9]+$/.test(release.deploymentId) : release.deploymentId !== "certification-local"))
    throw new Error("OPERATOR_RELEASE_BINDING_DENIED");
  const from = Date.parse(m.validFrom), until = Date.parse(m.validUntil);
  if (until <= from || until - from > 3_600_000 || now < from || (!cleanup && now >= until)) throw new Error("MANIFEST_WINDOW_DENIED");
  return m;
}
export async function ceremony(bytes: string, approval: Approval | undefined, execution: Execution, revoke = false) {
  // Invalid endpoint/manifest/approval fails before database access. Cleanup cannot create a grant.
  let m: ReturnType<typeof validate>;
  try { m = validate(bytes, approval, execution, Date.now(), revoke); }
  catch (error) {
    // Only a separately valid registered context may record a malformed replay.
    // Bad environment/endpoint or absence of a trusted registration still means SQL=0.
    const known = execution.registrations[0];
    if (known && process.env.DATABASE_URL === execution.url) {
      let baseline: ReturnType<typeof validate> | undefined;
      try { baseline = validate(known.bytes, known.approval, execution); } catch { /* no SQL */ }
      if (baseline) await withTenantDb(FIXED, async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${FIXED.organizationId}:${FIXED.tenantId}`},0))::text`;
        const changeId = `bootstrap:${baseline.operationId}:invalid:${hash(bytes)}`;
        if (!await tx.canonicalAdminAuditEvent.findFirst({ where: { organizationId: FIXED.organizationId, tenantId: FIXED.tenantId, changeId } }))
          await tx.canonicalAdminAuditEvent.create({ data: { organizationId: FIXED.organizationId, tenantId: FIXED.tenantId,
            actorSubjectId: FIXED.actorSubjectId, targetSubjectId: FIXED.targetSubjectId, changeId,
            operation: "RESOURCE.ONBOARDING.BOOTSTRAP.DENIED", result: "DENIED",
            metadata: { reasonCode: "MANIFEST_OR_APPROVAL_DENIED", manifestBinding: hash(known.bytes) } } });
      });
    }
    throw error; // outside the committed refusal transaction
  }
  if (process.env.DATABASE_URL !== execution.url) throw new Error("DATABASE_CLIENT_BINDING_DENIED");
  return withTenantDb(FIXED, async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${FIXED.organizationId}:${FIXED.tenantId}`},0))::text`;
    const [role] = await tx.$queryRaw<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean; database: string; database_time: Date }>>`
      SELECT current_user,rolsuper,rolbypassrls,current_database() AS database,clock_timestamp() AS database_time FROM pg_roles WHERE rolname=current_user`;
    if (role?.current_user !== "app_user" || role.rolsuper || role.rolbypassrls || role.database !== FIXED.database) throw new Error("RUNTIME_POSTURE_DENIED");
    if (!revoke && (Math.abs(Date.now()-role.database_time.getTime())>5_000 || role.database_time.getTime()<Date.parse(m.validFrom) ||
      role.database_time.getTime()>=Date.parse(m.validUntil))) throw new Error("DATABASE_CLOCK_OR_WINDOW_DENIED");
    const [posture] = await tx.$queryRaw<Array<{ owned: number; forced: number }>>`SELECT
      (SELECT count(*)::int FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND relnamespace='public'::regnamespace) owned,
      (SELECT count(*)::int FROM pg_class WHERE relname IN ('Subject','Assignment','Entitlement','Resource','ResourceScope','CanonicalAdminAuditEvent') AND relnamespace='public'::regnamespace AND relrowsecurity AND relforcerowsecurity) forced`;
    if (posture.owned || posture.forced !== 6) throw new Error("RLS_POSTURE_DENIED");
    const context = { organizationId: FIXED.organizationId, tenantId: FIXED.tenantId }, changeId = `bootstrap:${m.operationId}`;
    const deny = async (reasonCode: string) => {
      const deniedId = `${changeId}:denied:${reasonCode}`;
      if (!await tx.canonicalAdminAuditEvent.findFirst({ where: { ...context, changeId: deniedId } })) await tx.canonicalAdminAuditEvent.create({ data: {
        ...context, actorSubjectId: FIXED.actorSubjectId, targetSubjectId: FIXED.targetSubjectId,
        operation: "RESOURCE.ONBOARDING.BOOTSTRAP.DENIED", result: "DENIED", changeId: deniedId, metadata: { reasonCode, manifestBinding: hash(bytes) } } });
      return { outcome: "DENIED", reasonCode };
    };
    const prior = await tx.canonicalAdminAuditEvent.findFirst({ where: { ...context, changeId } });
    const row = await tx.assignment.findFirst({ where: { ...context, id: m.assignmentId } });
    const matches = row && row.subjectId === FIXED.targetSubjectId && row.entitlementId === FIXED.entitlementId && row.source === "DIRECT" &&
      row.sourceRef === changeId && row.validFrom?.getTime() === Date.parse(m.validFrom) && row.validUntil?.getTime() === Date.parse(m.validUntil);
    if (prior && (prior.operation !== "RESOURCE.ONBOARDING.BOOTSTRAP" || prior.result !== "SUCCESS" ||
      prior.actorSubjectId !== FIXED.actorSubjectId || prior.targetSubjectId !== FIXED.targetSubjectId ||
      prior.assignmentIds.length !== 1 || prior.assignmentIds[0] !== m.assignmentId ||
      (prior.metadata as { manifestBinding?: string })?.manifestBinding !== hash(bytes) ||
      (prior.metadata as { releaseBinding?: string })?.releaseBinding !== approval!.releaseBinding ||
      (prior.metadata as { deploymentSha?: string })?.deploymentSha !== m.productionDeploymentSha)) return deny("BOOTSTRAP_RECEIPT_CONFLICT");
    if (revoke) {
      if (!prior || !matches) return deny("BOOTSTRAP_RECEIPT_MISSING");
      if (row.status === "REVOKED") return { outcome: "REVOKED", replay: true };
      await tx.assignment.update({ where: { id: m.assignmentId }, data: { status: "REVOKED" } });
      await tx.canonicalAdminAuditEvent.create({ data: { ...context, actorSubjectId: FIXED.actorSubjectId, targetSubjectId: FIXED.targetSubjectId,
        changeId: `${changeId}:revoke`, operation: "RESOURCE.ONBOARDING.BOOTSTRAP.REVOKE", result: "SUCCESS", assignmentIds: [m.assignmentId],
        metadata: { manifestBinding: hash(bytes), operationId: m.operationId } } });
      return { outcome: "REVOKED", replay: false };
    }
    if (prior && (!matches || row.status !== "ACTIVE")) return deny("BOOTSTRAP_ALREADY_REVOKED_OR_CONFLICTING");
    // Recheck time after lock acquisition; no grant may cross expiry while waiting.
    if (Date.now() >= Date.parse(m.validUntil)) return deny("MANIFEST_WINDOW_DENIED");
    if (!await tx.subject.findFirst({ where: { ...context, id: FIXED.targetSubjectId, lifecycleState: "ACTIVE" } })) return deny("SUBJECT_NOT_ACTIVE");
    if (!await internalBinding(tx, { ...context, subjectId: FIXED.actorSubjectId })) return deny("RESOURCE_BINDING_DENIED");
    const sod = await evaluateSoD(tx, { ...context, subjectId: FIXED.targetSubjectId, entitlementId: FIXED.entitlementId,
      resourceId: FIXED.resourceId, scope: FIXED.scopeId, assignmentOperation: "CREATE", validFrom: new Date(m.validFrom), validUntil: new Date(m.validUntil) });
    if (sod.decision !== "ALLOW") return deny("SOD_CONFLICT");
    if (prior) return { outcome: "ALREADY_APPLIED" };
    if (row || await tx.assignment.count({ where: { ...context, entitlementId: FIXED.entitlementId } }) ||
      await tx.canonicalAdminAuditEvent.count({ where: { ...context, operation: "RESOURCE.ONBOARDING.BOOTSTRAP", result: "SUCCESS", metadata: { path: ["entitlementId"], equals: FIXED.entitlementId } } })) return deny("INITIAL_BOOTSTRAP_COLLISION");
    await tx.assignment.create({ data: { ...context, id: m.assignmentId, subjectId: FIXED.targetSubjectId, entitlementId: FIXED.entitlementId,
      source: "DIRECT", sourceRef: changeId, status: "ACTIVE", validFrom: new Date(m.validFrom), validUntil: new Date(m.validUntil) } });
    await tx.canonicalAdminAuditEvent.create({ data: { ...context, actorSubjectId: FIXED.actorSubjectId, targetSubjectId: FIXED.targetSubjectId,
      changeId, operation: "RESOURCE.ONBOARDING.BOOTSTRAP", result: "SUCCESS", assignmentIds: [m.assignmentId], metadata: {
        manifestBinding: hash(bytes), operationId: m.operationId, entitlementId: FIXED.entitlementId, resourceId: FIXED.resourceId,
        scopeId: FIXED.scopeId, action: FIXED.action, validFrom: m.validFrom, validUntil: m.validUntil,
        deploymentSha: m.productionDeploymentSha, releaseBinding: approval!.releaseBinding, approval: { ...approval! } } } });
    return { outcome: "CREATED" };
  });
}
