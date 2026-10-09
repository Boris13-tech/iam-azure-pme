// Operator READ-ONLY inspection. Never grants, issues sessions or calls providers.
import { PrismaClient } from "@prisma/client";
import { FIXED, PROFILES } from "./resource-owner-bootstrap";
import { internalBinding } from "../../lib/resources/onboarding";
import { evaluateSoD } from "../../lib/resources/sod";
import { evaluateResourceAccess } from "../../lib/resources/authorization";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (url.protocol !== "postgresql:" || url.hostname !== PROFILES.PRODUCTION.host || url.pathname !== "/neondb" ||
    url.username !== "app_user" || url.searchParams.get("sslmode") !== "require") throw new Error("PRODUCTION_READONLY_ENDPOINT_DENIED");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    const proof = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$queryRaw`SELECT set_config('app.organization_id',${FIXED.organizationId},true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id',${FIXED.tenantId},true)`;
      const posture = await tx.$queryRaw`SELECT current_user,current_database(),rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      const preserved: Record<string, unknown> = {};
      for (const table of ['Subject','IdentityAccount','Assignment','Resource','ResourceScope','Entitlement','ProviderConnection','User','Role','Permission','UserRole','AccessPolicy','AuditLog','LegacyUserBridge'])
        preserved[table] = await tx.$queryRawUnsafe(`SELECT count(*)::int n,md5(coalesce(string_agg(to_jsonb(r)::text,'|' ORDER BY to_jsonb(r)::text),'')) digest FROM "${table}" r`);
      const context = { organizationId: FIXED.organizationId, tenantId: FIXED.tenantId, subjectId: FIXED.actorSubjectId };
      const subject = await tx.subject.findFirst({ where: { organizationId: FIXED.organizationId, tenantId: FIXED.tenantId, id: FIXED.targetSubjectId }, select: { lifecycleState: true } });
      const binding = await internalBinding(tx, context);
      const bootstrapAssignments = await tx.assignment.count({ where: { entitlementId: FIXED.entitlementId } });
      const sod = await evaluateSoD(tx, { ...context, entitlementId: FIXED.entitlementId, resourceId: FIXED.resourceId,
        scope: FIXED.scopeId, assignmentOperation: 'CREATE', validFrom: new Date(), validUntil: new Date(Date.now()+3_600_000) });
      const decision = await evaluateResourceAccess(tx, { ...context, resourceId: FIXED.resourceId, entitlementKey: FIXED.entitlementKey, action: FIXED.action });
      const rls = await tx.$queryRaw`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('Subject','IdentityAccount','Assignment','Resource','ResourceScope','Entitlement','Session','CanonicalAdminAuditEvent','SoDPolicy','SoDRule','AccessReviewCampaign','AccessReviewItem') ORDER BY relname`;
      const owned = await tx.$queryRaw`SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)`;
      const publicFunctions = await tx.$queryRaw`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='public' AND p.proname LIKE 'luxia_%' AND a.grantee=0 AND a.privilege_type='EXECUTE'`;
      const defaultPublicExecute = await tx.$queryRaw`SELECT d.defaclrole::regrole::text creator,d.defaclnamespace::text namespace FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclobjtype='f' AND a.grantee=0 AND a.privilege_type='EXECUTE'`;
      const defaults = await tx.$queryRaw`SELECT d.defaclrole::regrole::text creator,d.defaclnamespace::text namespace,d.defaclacl::text acl FROM pg_default_acl d WHERE d.defaclobjtype='f'`;
      const migrations = await tx.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
      const sessions = await tx.$queryRaw`SELECT count(*)::int total,count(*) FILTER(WHERE "revokedAt" IS NULL AND "expiresAt">now())::int unexpired FROM "Session"`;
      return { utc:new Date().toISOString(), environment:'PRODUCTION', branch:PROFILES.PRODUCTION.branch,
        posture,preserved,subject,binding,bootstrapAssignments,sod,protectedAuthorization:decision.allowed?'ALLOW':'DENY',
        rls,owned,publicFunctions,defaultPublicExecute,defaults,migrations,sessions,mutations:'NONE' };
    }, { timeout:60_000, maxWait:10_000 });
    console.log(JSON.stringify(proof));
  } finally { await db.$disconnect(); }
}
main().catch(()=>{console.error('PRODUCTION_READONLY_PREFLIGHT_STOP — no raw diagnostics');process.exitCode=1;});
