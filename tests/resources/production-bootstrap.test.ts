import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { FIXED, PROFILES, VERCEL_PROJECT_ID, ABANDONED, hash, validate, ceremony, type Execution } from "../../scripts/operators/resource-owner-bootstrap";
import { withTenantDb } from "../../lib/db/scoped-client";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { SessionStore } from "../../lib/auth/session-store";
import { authorize } from "../../lib/resources/authorization";
import { PrismaClient, type Prisma } from "@prisma/client";

const now = Date.now();
const deploymentSha = "5704558f5c343ae653c8984917b90a760caeabf1";
const m = { manifestVersion: 1, environment: "CERTIFICATION_ONLY", ...FIXED, branch: PROFILES.CERTIFICATION_ONLY.branch,
  productionDeploymentSha: deploymentSha,
  scopeType: "RESOURCE", purpose: "INITIAL_BOUNDED_RESOURCE_OWNER", source: "DIRECT", assignmentId: randomUUID(), operationId: randomUUID(),
  validFrom: new Date(now - 1000).toISOString(), validUntil: new Date(now + 3_500_000).toISOString(),
  approvedAt: "PENDING_EXPLICIT_HUMAN_APPROVAL", approvedBy: "PENDING_EXPLICIT_HUMAN_APPROVAL", approvalReference: "PENDING_EXPLICIT_HUMAN_APPROVAL",
  requiredResourceBinding: "EXACT_ACTIVE_RESOURCE_SCOPE_ENTITLEMENT" };
const bytes = JSON.stringify(m);
const release = { releaseVersion: 1, environment: "CERTIFICATION_ONLY", projectId: FIXED.projectId,
  branch: PROFILES.CERTIFICATION_ONLY.branch, database: FIXED.database, vercelProjectId: VERCEL_PROJECT_ID,
  deployedSha: deploymentSha, deploymentId: "certification-local", manifestBinding: hash(bytes) };
const releaseBytes = JSON.stringify(release), approval = { manifestBinding: hash(bytes), releaseBinding: hash(releaseBytes), approvedAt: new Date(now - 500).toISOString(),
  approvedBy: "operator-authorized-certification-only", approvalReference: "2026-10-08 dedicated runner certification instruction" };
const ex: Execution = { mode: "CERTIFICATION_ONLY", url: (process.env.LUXIA_PRODUCTION_RUNNER_CERTIFICATION === 'true' || process.env.LUXIA_PRODUCTION_RUNNER_NEGATIVES === 'true') ? process.env.DATABASE_URL! : `postgresql://app_user@${PROFILES.CERTIFICATION_ONLY.host}/neondb?sslmode=require`,
  origin: PROFILES.CERTIFICATION_ONLY.origin, deployedSha: deploymentSha, deploymentId: release.deploymentId,
  verifiedProject: FIXED.projectId, verifiedBranch: PROFILES.CERTIFICATION_ONLY.branch, registrations: [{ bytes, releaseBytes, approval }] };
const auth = { organizationId: FIXED.organizationId, tenantId: FIXED.tenantId, subjectId: FIXED.actorSubjectId };

describe("independent operator runner hard guards", () => {
  it("pins a separately registered release to exact manifest, approval, deployment ID and SHA", () => {
    for (const field of Object.keys(release)) {
      const modifiedRelease = JSON.stringify({ ...release, [field]: 'modified' });
      expect(() => validate(bytes, approval, { ...ex, registrations: [{ bytes, releaseBytes: modifiedRelease, approval }] })).toThrow();
    }
    expect(() => validate(bytes, { ...approval, releaseBinding: 'wrong' }, ex)).toThrow();
    expect(() => validate(bytes, approval, { ...ex, deploymentId: 'another-deployment' })).toThrow();
    expect(() => validate(bytes, approval, { ...ex, registrations: [{ bytes, releaseBytes: releaseBytes+' ', approval }] })).toThrow();
    // New releases require NEW exact manifest bytes AND fresh detached approval, never an env override.
    const sha = '1234567890123456789012345678901234567890';
    const newBytes = JSON.stringify({ ...m, productionDeploymentSha: sha });
    const newReleaseBytes = JSON.stringify({ ...release, deployedSha: sha, manifestBinding: hash(newBytes) });
    const newApproval = { ...approval, manifestBinding: hash(newBytes), releaseBinding: hash(newReleaseBytes) };
    const next = { ...ex, deployedSha: sha, registrations: [{ bytes: newBytes, releaseBytes: newReleaseBytes, approval: newApproval }] };
    expect(validate(newBytes, newApproval, next).productionDeploymentSha).toBe(sha);
    expect(() => validate(newBytes, approval, next)).toThrow();
    expect(() => validate(newBytes, newApproval, { ...next, deployedSha: deploymentSha })).toThrow();
    expect(readFileSync('scripts/operators/run-production-resource-bootstrap.ts','utf8')).toContain('id !== expected.deploymentId');
    expect(readFileSync('scripts/operators/production-bootstrap-registry.ts','utf8')).toContain('Object.freeze([])');
  });
  it("accepts only exact registered bytes and detached approval", () => {
    expect(validate(bytes, approval, ex).assignmentId).toBe(m.assignmentId);
    for (const field of Object.keys(m)) expect(() => validate(JSON.stringify({ ...m, [field]: "modified" }), approval, ex)).toThrow();
    expect(() => validate(bytes + "\n", approval, ex)).toThrow();
    expect(() => validate(bytes, undefined, ex)).toThrow("OPERATOR_APPROVAL_DENIED");
    expect(() => validate(bytes, { ...approval, manifestBinding: "wrong" }, ex)).toThrow();
    expect(() => validate(bytes, approval, { ...ex, registrations: [] })).toThrow();
    expect(() => validate(bytes, approval, ex, now - 10_000)).toThrow();
    expect(() => validate(bytes, approval, ex, now + 4_000_000)).toThrow();
  });
  it("cannot resolve certification to Production or trust an environment label", () => {
    for (const change of [{ mode: "PRODUCTION" }, { url: `postgresql://app_user@${PROFILES.PRODUCTION.host}/neondb?sslmode=require` },
      { verifiedBranch: PROFILES.PRODUCTION.branch }, { verifiedProject: "wrong" }, { deployedSha: "wrong" },
      { origin: PROFILES.PRODUCTION.origin }, { url: ex.url.replace('/neondb', '/other') }, { url: ex.url.replace('app_user', 'neondb_owner') }]) {
      expect(() => validate(bytes, approval, { ...ex, ...change } as Execution)).toThrow();
    }
    expect(ABANDONED).toBe("95e9b80de3e28890faf01eb41fb70002d6ef1efb6986815da8b8868799376232");
  });
  it("operator modules are unreachable from application modules and clone runner is not imported", () => {
    for (const file of ['app/api/canonical/resource-onboarding/route.ts','app/api/resources/protected-resource-demo/route.ts','lib/resources/onboarding.ts'])
      expect(readFileSync(file,'utf8')).not.toMatch(/operators|resource-owner-bootstrap|createSession|session\.(create|upsert)/);
    expect(readFileSync('scripts/operators/resource-owner-bootstrap.ts','utf8')).not.toMatch(/certification\/resource-bootstrap|APPROVED_BYTES/);
    expect(hash(readFileSync('docs/certification/PR14-SESSION-DELTA-ATTRIBUTION-2026-10-08.md','utf8')))
      .toBe('801333ca13e4f6bd935449540314193be38c4715479d640771925f7baf2a7490');
    expect(readFileSync('.gitattributes','utf8')).toContain('docs/certification/PR14-SESSION-DELTA-ATTRIBUTION-2026-10-08.md -text');
    const preflight=readFileSync('scripts/operators/production-resource-preflight.ts','utf8');
    expect(preflight).toContain('SET TRANSACTION READ ONLY');
    expect(preflight).not.toMatch(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/);
    expect(preflight.indexOf('SET TRANSACTION READ ONLY')).toBeLessThan(preflight.indexOf("set_config('app.organization_id'"));
  });
});

async function preserved() {
  return withTenantDb(auth, async tx => {
    const result: Record<string, unknown> = {};
    for (const table of ['Subject','IdentityAccount','ProviderConnection','User','Role','Permission','UserRole','AccessPolicy','AuditLog','LegacyUserBridge','Resource','ResourceScope','Entitlement'])
      result[table] = await tx.$queryRawUnsafe(`SELECT count(*)::int n,md5(coalesce(string_agg(to_jsonb(r)::text,'|' ORDER BY to_jsonb(r)::text),'')) digest FROM "${table}" r`);
    result.Assignment = await tx.$queryRaw`SELECT count(*)::int n,md5(coalesce(string_agg(to_jsonb(r)::text,'|' ORDER BY to_jsonb(r)::text),'')) digest FROM "Assignment" r WHERE id<>${m.assignmentId}`;
    return result;
  });
}
describe.runIf(process.env.LUXIA_PRODUCTION_RUNNER_CERTIFICATION === 'true')('dedicated runner real PostgreSQL/RLS + HTTP', () => {
  it('DENY → exact grant → ALLOW → revoke → DENY; negative guards and immutable evidence', async () => {
    validate(bytes, approval, ex);
    const baseline = await preserved();
    const account = await withTenantDb(auth, tx => tx.identityAccount.findFirstOrThrow({ where: { subjectId: auth.subjectId, status: 'ACTIVE' } }));
    // Certification clone only; no Production session is created or copied into HTTP.
    const session = await SessionStore.createSession({ ...auth, identityAccountId: account.id });
    const server = spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'dev','-p','3196'], { windowsHide:true,
      env:{...process.env,NEXT_PUBLIC_APP_URL:ex.origin,AUTHZ_MODE:'native'},stdio:['ignore','pipe','pipe'] });
    let output='';server.stdout.on('data',x=>{output+=x;});server.stderr.on('data',x=>{output+=x;});
    const route=`${ex.origin}/api/resources/protected-resource-demo`, headers={cookie:`luxia_session=${session.rawToken}`};
    try {
      let ready=false;for(let i=0;i<120;i++){try{if((await fetch(route)).status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}expect(ready).toBe(true);
      expect((await fetch(route,{headers})).status).toBe(403);
      for(const [candidate,attestation] of [[bytes+' ',approval],[bytes,undefined],[bytes,{...approval,manifestBinding:'wrong'}]] as const)
        await expect(ceremony(candidate,attestation,ex)).rejects.toBeDefined();
      const results=await Promise.allSettled([ceremony(bytes,approval,ex),ceremony(bytes,approval,ex)]);
      expect(results.every(x=>x.status==='fulfilled')).toBe(true);
      expect(results.flatMap(x=>x.status==='fulfilled'?[x.value.outcome]:[]).sort()).toEqual(['ALREADY_APPLIED','CREATED']);
      const allowed=await fetch(route,{headers});expect(allowed.status).toBe(200);
      const receipt=await withTenantDb(auth,tx=>tx.canonicalAdminAuditEvent.findFirstOrThrow({where:{changeId:`bootstrap:${m.operationId}`}}));
      expect(receipt.assignmentIds).toEqual([m.assignmentId]);expect(receipt.metadata).toMatchObject({manifestBinding:hash(bytes),releaseBinding:hash(releaseBytes),deploymentSha,approval});
      const alteredReleaseBytes=releaseBytes+'\n';
      const alteredApproval={...approval,releaseBinding:hash(alteredReleaseBytes)};
      expect(await ceremony(bytes,alteredApproval,{...ex,registrations:[{bytes,releaseBytes:alteredReleaseBytes,approval:alteredApproval}]}))
        .toMatchObject({outcome:'DENIED',reasonCode:'BOOTSTRAP_RECEIPT_CONFLICT'});
      const row=await withTenantDb(auth,tx=>tx.assignment.findFirstOrThrow({where:{id:m.assignmentId},include:{entitlement:{include:{resourceScope:true}}}}));
      expect(row.source).toBe('DIRECT');expect(row.entitlement.resourceScope?.kind).toBe('RESOURCE');expect(row.entitlement.resourceScope?.resourceId).toBe(FIXED.resourceId);
      expect(row.validUntil!.getTime()-row.validFrom!.getTime()).toBeLessThanOrEqual(3_600_000);
      const foreign={...auth,tenantId:randomUUID()};expect((await authorize({...foreign,resourceId:FIXED.resourceId,entitlementKey:FIXED.entitlementKey,action:FIXED.action})).allowed).toBe(false);
      expect(await withTenantDb(foreign,tx=>tx.canonicalAdminAuditEvent.count({where:{id:receipt.id}}))).toBe(0);
      await expect(withTenantDb(auth,tx=>tx.canonicalAdminAuditEvent.update({where:{id:receipt.id},data:{metadata:{}}}))).rejects.toBeDefined();
      expect(await ceremony(bytes,approval,ex,true)).toMatchObject({outcome:'REVOKED'});
      expect((await fetch(route,{headers})).status).toBe(403);
      expect(await ceremony(bytes,approval,ex)).toMatchObject({outcome:'DENIED',reasonCode:'BOOTSTRAP_ALREADY_REVOKED_OR_CONFLICTING'});
      expect(await ceremony(bytes,approval,ex,true)).toMatchObject({outcome:'REVOKED',replay:true});
      const rows=await withTenantDb(auth,tx=>tx.assignment.findMany({where:{entitlementId:FIXED.entitlementId}}));expect(rows).toHaveLength(1);expect(rows[0].status).toBe('REVOKED');
      const audit=await withTenantDb(auth,tx=>tx.canonicalAdminAuditEvent.findMany({where:{changeId:{startsWith:`bootstrap:${m.operationId}`}}}));
      expect(audit.filter(x=>x.operation==='RESOURCE.ONBOARDING.BOOTSTRAP')).toHaveLength(1);expect(audit.some(x=>x.result==='DENIED')).toBe(true);
      expect(JSON.stringify(audit)).not.toMatch(/password|secret|bearer|access_token|refresh_token/i);expect(output).not.toContain(session.rawToken);
      expect(await preserved()).toEqual(baseline);
    } finally {
      try{const active=await withTenantDb(auth,tx=>tx.assignment.count({where:{id:m.assignmentId,status:'ACTIVE'}}));if(active)await ceremony(bytes,approval,ex,true);}
      finally{await SessionStore.revokeByToken(session.rawToken);if(process.platform==='win32'&&server.pid)spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else server.kill();await rawPrisma.$disconnect();}
    }
  },240_000);
});

describe.runIf(process.env.LUXIA_PRODUCTION_RUNNER_NEGATIVES === 'true')('clone-only data guard negatives', () => {
  it('rejects inactive Subject, inactive binding and real SoD conflict without creating a grant', async () => {
    validate(bytes,approval,ex); const baseline=await preserved();
    const context={organizationId:FIXED.organizationId,tenantId:FIXED.tenantId};
    const original=await withTenantDb(auth,tx=>tx.subject.findFirstOrThrow({where:{id:auth.subjectId}}));
    const resource=await withTenantDb(auth,tx=>tx.resource.findFirstOrThrow({where:{id:FIXED.resourceId}}));
    const otherId=randomUUID(),otherAssignment=randomUUID(),policyId=randomUUID(),ruleId=randomUUID();
    const ownerUrl=new URL(process.env.LUXIA_RUNNER_FIXTURE_OWNER_URL!);
    if(ownerUrl.hostname!=='ep-still-morning-ah7s0usw.c-3.us-east-1.aws.neon.tech'||ownerUrl.pathname!=='/neondb')throw new Error('FIXTURE_CLONE_ONLY');
    const owner=new PrismaClient({datasources:{db:{url:ownerUrl.toString()}}});
    const fixture=<T>(work:(tx:Prisma.TransactionClient)=>Promise<T>)=>owner.$transaction(async tx=>{
      await tx.$queryRaw`SELECT set_config('app.organization_id',${context.organizationId},true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id',${context.tenantId},true)`;return work(tx);
    });
    try {
      await fixture(tx=>tx.subject.update({where:{id:auth.subjectId},data:{lifecycleState:'SUSPENDED'}}));
      expect(await ceremony(bytes,approval,ex)).toMatchObject({outcome:'DENIED',reasonCode:'SUBJECT_NOT_ACTIVE'});
      await fixture(tx=>tx.subject.update({where:{id:auth.subjectId},data:{lifecycleState:original.lifecycleState,updatedAt:original.updatedAt}}));
      await fixture(tx=>tx.resource.update({where:{id:FIXED.resourceId},data:{active:false}}));
      expect(await ceremony(bytes,approval,ex)).toMatchObject({outcome:'DENIED',reasonCode:'RESOURCE_BINDING_DENIED'});
      await fixture(tx=>tx.resource.update({where:{id:FIXED.resourceId},data:{active:resource.active,updatedAt:resource.updatedAt}}));
      await fixture(async tx=>{
        await tx.entitlement.create({data:{...context,id:otherId,key:`runner-negative:${otherId}`,action:'certification-conflict',resource:'resource-scope',resourceScopeId:FIXED.scopeId}});
        await tx.assignment.create({data:{...context,id:otherAssignment,subjectId:auth.subjectId,entitlementId:otherId,source:'DIRECT',validUntil:new Date(m.validUntil)}});
        await tx.soDPolicy.create({data:{...context,id:policyId,key:`runner-negative:${policyId}`,scopeId:FIXED.scopeId,status:'ACTIVE'}});
        const [entitlementAId,entitlementBId]=[FIXED.entitlementId,otherId].sort();
        await tx.soDRule.create({data:{...context,id:ruleId,policyId,entitlementAId,entitlementBId}});
      });
      expect(await ceremony(bytes,approval,ex)).toMatchObject({outcome:'DENIED',reasonCode:'SOD_CONFLICT'});
      expect(await withTenantDb(auth,tx=>tx.assignment.count({where:{id:m.assignmentId}}))).toBe(0);
      const denials=await withTenantDb(auth,tx=>tx.canonicalAdminAuditEvent.findMany({where:{changeId:{startsWith:`bootstrap:${m.operationId}`},result:'DENIED'}}));
      expect(denials).toHaveLength(3);
    } finally {
      await fixture(async tx=>{
        await tx.soDRule.deleteMany({where:{id:ruleId}});await tx.soDPolicy.deleteMany({where:{id:policyId}});
        await tx.assignment.deleteMany({where:{id:otherAssignment}});await tx.entitlement.deleteMany({where:{id:otherId}});
        await tx.subject.update({where:{id:auth.subjectId},data:{lifecycleState:original.lifecycleState,updatedAt:original.updatedAt}});
        await tx.resource.update({where:{id:resource.id},data:{active:resource.active,updatedAt:resource.updatedAt}});
      });
      expect(await preserved()).toEqual(baseline);await owner.$disconnect();await rawPrisma.$disconnect();
    }
  },120_000);
});
