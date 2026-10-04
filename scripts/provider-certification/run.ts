import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { preflight, type Profile } from './preflight';
import { completeEvidence } from './evidence';

export async function run(profile: Profile) {
  const gate = preflight(profile, process.env);
  if (!gate.ready) { console.log(JSON.stringify({ profile, status:'BLOCKED', missing:gate.missing })); process.exitCode=2; return; }
  process.env.DATABASE_URL = process.env.LUXIA_CERT_DATABASE_URL;
  const admin = new PrismaClient({ datasources:{ db:{ url:process.env.LUXIA_CERT_DATABASE_MIGRATION_URL } } });
  const runtime = new PrismaClient();
  const evidence: Record<string, { result:string; source:string }> = {};
  const secrets = Object.entries(process.env).filter(([name,value]) => value && /SECRET|TOKEN|DATABASE.*URL/.test(name)).map(([,value]) => value!);
  const clean = (value:unknown) => { const text=JSON.stringify(value); if (secrets.some(secret => text.includes(secret))) throw new Error('SECRET_EXPOSURE'); };
  const pass = (name:string,source='LIVE') => { evidence[name]={result:'PASS',source}; };
  const originalFetch=globalThis.fetch;
  let directoryCalls=0;
  const stableIds=new Set<string>();
  globalThis.fetch = async (...args:Parameters<typeof fetch>) => {
    const response=await originalFetch(...args);
    const url=new URL(String(args[0]));
    if (response.ok && ['graph.microsoft.com','admin.googleapis.com'].includes(url.hostname)) {
      directoryCalls++;
      const page=await response.clone().json() as {value?:Array<{id?:unknown}>;users?:Array<{id?:unknown}>};
      for (const item of page.value ?? page.users ?? []) if(typeof item.id==='string') stableIds.add(item.id);
    }
    return response;
  };
  try {
    const role = await runtime.$queryRaw<Array<{ current_user:string; rolsuper:boolean; rolbypassrls:boolean }>>`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    if (role[0]?.current_user !== 'app_user' || role[0].rolsuper || role[0].rolbypassrls) throw new Error('POSTURE');
    pass('Runtime posture','NEON');
    const auth = { organizationId:process.env[`LUXIA_CERT_${profile}_ORGANIZATION_ID`]!, tenantId:process.env[`LUXIA_CERT_${profile}_TENANT_SCOPE_ID`]!, subjectId:process.env[`LUXIA_CERT_${profile}_ACTOR_SUBJECT_ID`]! };
    const id = process.env[`LUXIA_CERT_${profile}_CONNECTION_ID`]!;
    const { withTenantDb } = await import('../../lib/db/scoped-client');
    const scope = await withTenantDb(auth, tx => tx.providerConnectionTenantScope.findUnique({ where:{ organizationId_tenantId_providerConnectionId:{ organizationId:auth.organizationId,tenantId:auth.tenantId,providerConnectionId:id } }, include:{providerConnection:true} }));
    const type = profile === 'ENTRA' ? 'MICROSOFT_ENTRA' : profile === 'GOOGLE' ? 'GOOGLE_WORKSPACE' : 'OIDC_GENERIC';
    const config = scope?.configuration as Record<string,unknown> | undefined;
    if (!scope?.enabled || scope.providerConnection.providerType !== type) throw new Error('SCOPE');
    if (profile === 'ENTRA' && (scope.providerConnection.externalScopeId !== process.env.LUXIA_CERT_ENTRA_TENANT_ID || config?.clientId !== process.env.LUXIA_CERT_ENTRA_CLIENT_ID)) throw new Error('SCOPE');
    if (profile === 'GOOGLE' && (scope.providerConnection.externalScopeId !== process.env.LUXIA_CERT_GOOGLE_CUSTOMER_ID || config?.customerId !== process.env.LUXIA_CERT_GOOGLE_CUSTOMER_ID)) throw new Error('SCOPE');
    if (profile === 'OIDC' && (scope.providerConnection.externalScopeId !== process.env.LUXIA_CERT_OIDC_ISSUER || config?.issuer !== process.env.LUXIA_CERT_OIDC_ISSUER)) throw new Error('SCOPE');
    const { connectionSecretReference } = await import('../../lib/provider-management/contracts');
    const ref = connectionSecretReference({ ...auth,providerConnectionId:id });
    if (profile !== 'OIDC') {
      if (scope.credentialSecretRef !== ref) throw new Error('SECRET_SCOPE');
      process.env[ref] = profile === 'ENTRA' ? process.env.LUXIA_CERT_ENTRA_CLIENT_SECRET : process.env.LUXIA_CERT_GOOGLE_ACCESS_TOKEN;
    }
    const secretReferenceBefore=process.env[ref];
    const inventory = async () => JSON.stringify(await Promise.all([
      admin.subject.findMany({orderBy:{id:'asc'}}), admin.identityAccount.findMany({orderBy:{id:'asc'}}),
      admin.user.findMany({orderBy:{id:'asc'}}), admin.legacyUserBridge.findMany({orderBy:{id:'asc'}}),
      admin.role.findMany({orderBy:{id:'asc'}}), admin.permission.findMany({orderBy:{id:'asc'}}),
      admin.userRole.findMany(), admin.rolePermission.findMany(), admin.accessPolicy.findMany({orderBy:{id:'asc'}}), admin.auditLog.findMany({orderBy:{id:'asc'}}),
    ]));
    const before = await inventory();
    const { runProviderOperation, configureProvider, providerDetail, rejectCollisionProjection } = await import('../../lib/provider-management/service');
    const { createManagedHttpDriver } = await import('../../lib/provider-adapters/implementations/managed-http/driver');
    const operationId = randomUUID();
    const connection = await runProviderOperation(auth,id,'CONNECTION_TEST',operationId,createManagedHttpDriver);
    if (connection?.status !== 'DRY_RUN_COMPLETE') throw new Error('CONNECTION');
    clean(connection); pass('Connection test'); pass(profile==='OIDC'?'HTTPS exact issuer metadata':'Directory read consent');
    const replay = await runProviderOperation(auth,id,'CONNECTION_TEST',operationId,() => { throw new Error('REPLAY_NETWORK'); });
    if (replay?.id !== connection.id) throw new Error('REPLAY');
    pass('Operation idempotency','NEON');
    let rejected=false;
    try { await runProviderOperation(auth,id,'SYNC_DRY_RUN',operationId,createManagedHttpDriver); }
    catch(error) { rejected=(error as {code?:string}).code==='PROVIDER_OPERATION_ID_CONFLICT'; }
    if (!rejected) throw new Error('OPERATION_CONFLICT');
    pass('Operation conflict','NEON');
    let calls=0;
    const refuseNetwork = () => { calls++; throw new Error('FORBIDDEN_NETWORK'); };
    try { await runProviderOperation({...auth,tenantId:randomUUID()},id,'CONNECTION_TEST',randomUUID(),refuseNetwork); throw new Error('NOT_DENIED'); }
    catch(error) { if((error as {httpStatus?:number}).httpStatus!==404 || calls!==0) throw new Error('TENANT_DENIAL'); }
    pass('Cross-tenant deny before network','NEON');
    try { await configureProvider(auth,id,{expectedMappingVersion:scope.mappingVersion,credentialSecretRef:connectionSecretReference({...auth,tenantId:randomUUID(),providerConnectionId:id})},randomUUID()); throw new Error('NOT_DENIED'); }
    catch(error) { if((error as {code?:string}).code!=='PROVIDER_SECRET_SCOPE_MISMATCH') throw new Error('SECRET_SCOPE'); }
    pass('Secret scope','NEON');
    let discoveryStatus = 'NOT_APPLICABLE';
    if (profile !== 'OIDC') {
      directoryCalls=0; stableIds.clear();
      const projections: import('../../lib/provider-management/contracts').DiscoveryProjection[]=[];
      const discovery = await runProviderOperation(auth,id,'SYNC_DRY_RUN',randomUUID(),input => {
        const driver=createManagedHttpDriver(input);
        return {...driver,async *discover() { for await (const projection of driver.discover()) {projections.push(projection);yield projection;} }};
      });
      discoveryStatus = discovery?.status ?? 'FAIL';
      if (!['DRY_RUN_COMPLETE','CONFLICTED'].includes(discoveryStatus)) throw new Error('DISCOVERY');
      clean(discovery);clean(projections);pass('Discovery');
      if (projections.some(p=>!stableIds.has(profile==='GOOGLE'?p.externalObjectId.replace(/^google_workspace:identity:/,''):p.externalObjectId))) throw new Error('UNSTABLE_ID');
      pass('Stable external IDs');
      evidence['Live pagination']={result:directoryCalls>=2 && directoryCalls<=10 && projections.length<=1000?'PASS':'BLOCKED',source:'LIVE'};
      if (!projections.length) throw new Error('COLLISION_FIXTURE_UNAVAILABLE');
      // Reinject one actual live projection twice: real DB quarantine, controlled duplicate.
      const collision=await runProviderOperation(auth,id,'SYNC_DRY_RUN',randomUUID(),() => ({testConnection:async()=>{},async *discover(){yield projections[0];yield projections[0];}}));
      if(collision?.status!=='CONFLICTED' || collision.conflicts!==1) throw new Error('COLLISION');
      const detail=await providerDetail(auth,id,randomUUID());
      const duplicate=detail.collisions.find(c=>!c.resolvedAt && c.externalObjectId===projections[0].externalObjectId);
      if(!duplicate) throw new Error('QUARANTINE');
      await rejectCollisionProjection(auth,id,duplicate.id,randomUUID());
      pass('Collision quarantine/rejection','CONTROLLED_DUPLICATE_NEON');
      const negative = async (credential:string,clientId?:string) => {
        process.env[ref]=credential; secrets.push(credential);
        try {
          const failure=await runProviderOperation(auth,id,'CONNECTION_TEST',randomUUID(),input=>createManagedHttpDriver({...input,
            ...(clientId?{configuration:{...config,clientId}}:{})}));
          clean(failure);
          if(failure?.status!=='FAILED'||!['PROVIDER_ACCESS_DENIED','PROVIDER_HTTP_FAILURE'].includes(failure.safeErrorCode ?? '')) throw new Error('NEGATIVE_CREDENTIAL');
        } finally { process.env[ref]=secretReferenceBefore; }
      };
      await negative(randomUUID());pass('Invalid credential safe failure');
      if(profile==='ENTRA') await negative(process.env.LUXIA_CERT_ENTRA_NO_CONSENT_CLIENT_SECRET!,process.env.LUXIA_CERT_ENTRA_NO_CONSENT_CLIENT_ID);
      else await negative(process.env.LUXIA_CERT_GOOGLE_REVOKED_ACCESS_TOKEN!);
      pass(profile==='ENTRA'?'Insufficient consent safe failure':'Revoked credential safe failure');
    } else {
      try { await runProviderOperation(auth,id,'SYNC_DRY_RUN',randomUUID(),refuseNetwork);throw new Error('ENUMERATION'); }
      catch(error) { if((error as {code?:string}).code!=='DIRECTORY_DISCOVERY_UNSUPPORTED'||calls)throw new Error('ENUMERATION'); }
      pass('No directory enumeration','NEON');
    }
    const current=await providerDetail(auth,id,randomUUID());
    const version=await configureProvider(auth,id,{expectedMappingVersion:current.provider.mappingVersion,enabled:false},randomUUID());
    const disabledChangeId=randomUUID();
    try {
      try { await runProviderOperation(auth,id,'CONNECTION_TEST',disabledChangeId,refuseNetwork);throw new Error('NOT_DENIED'); }
      catch(error) { if((error as {code?:string}).code!=='PROVIDER_DISABLED'||calls)throw new Error('DISABLED'); }
      pass('Disabled management operations','NEON');
    } finally { await configureProvider(auth,id,{expectedMappingVersion:version.mappingVersion,enabled:true},randomUUID()); }
    const audits=await admin.canonicalAdminAuditEvent.findMany({where:{organizationId:auth.organizationId,tenantId:auth.tenantId,occurredAt:{gte:connection.startedAt}}});
    clean(audits);
    if(!audits.some(a=>a.changeId===disabledChangeId&&a.result==='DENIED'&&a.operation==='PROVIDER.CONNECTION_TEST.DENIED'))throw new Error('DENIAL_AUDIT_MISSING');
    pass('Rejection audit','NEON');
    if(!audits.some(a=>a.operation==='PROVIDER.CONNECTION_TEST.COMPLETE'&&a.result==='SUCCESS') ||
      (profile!=='OIDC' && (!audits.some(a=>a.operation==='PROVIDER.CONNECTION_TEST.COMPLETE'&&a.result==='FAILURE')||!audits.some(a=>a.operation==='PROVIDER.COLLISION.REJECT_PROJECTION'))))throw new Error('AUDIT');
    pass('Canonical audit','NEON');
    // Transport attacks/bounds use isolated mocks, never an unapproved live issuer.
    const controlled=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','tests/provider-adapters/managed-http-driver.test.ts','tests/provider-adapters/oidc-ssrf.test.ts'],{encoding:'utf8',timeout:60000,
      env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,NODE_ENV:'test'}});
    clean(controlled.stdout);clean(controlled.stderr);
    if(controlled.status!==0)throw new Error('CONTROLLED_TRANSPORT_SUITE');
    pass('Pagination bounds / HTTPS / issuer mismatch / redirects / SSRF / safe errors','CONTROLLED_TRANSPORT');
    if (await inventory() !== before) throw new Error('CANONICAL_MUTATIONS');
    pass('No Subject/IdentityAccount/legacy/bridge mutation','NEON');pass('Public service results / audit secret scan','NEON');
    const { httpEvidence }=await import('./http-evidence');
    await httpEvidence({id,session:process.env[`LUXIA_CERT_${profile}_HTTP_SESSION_TOKEN`]!,
      foreignSession:process.env[`LUXIA_CERT_${profile}_FOREIGN_HTTP_SESSION_TOKEN`]!,secretRef:ref,clean});
    if(await inventory()!==before)throw new Error('HTTP_CANONICAL_MUTATIONS');
    pass('HTTP/application-log secret scan','LIVE_LOOPBACK_HTTP');
    const complete=completeEvidence(profile,evidence);
    console.log(JSON.stringify({profile,status:complete?'PASS':'BLOCKED',evidence}));process.exitCode=complete?0:2;
  } catch { console.log(JSON.stringify({profile,status:'FAIL',safeCode:'LIVE_CERTIFICATION_FAILED',evidence})); process.exitCode=1; }
  finally { globalThis.fetch=originalFetch; await runtime.$disconnect(); await admin.$disconnect(); }
}
