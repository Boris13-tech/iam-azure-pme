import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {adminPrisma} from '../helpers/admin-prisma';
import {withTenantDb} from '../../lib/db/scoped-client';
import {SecretLease,type SecretResolver} from '../../lib/provider-adapters';
import {createScopedTokenStore} from '../../lib/provider-management/scoped-token-store';
import {connectionSecretReference,versionedConnectionSecretReference} from '../../lib/provider-management/contracts';
import type {TokenContext} from '../../lib/provider-management/token-manager';
import {createVersionedEntraDriver} from '../../lib/provider-adapters/implementations/managed-http/versioned-entra-driver';

describe('Versioned token custody — real runtime PostgreSQL/RLS, no provider IO',()=>{
  const org=randomUUID(),tenant=randomUUID(),other=randomUUID(),actor=randomUUID(),foreignActor=randomUUID();
  const auth={organizationId:org,tenantId:tenant,subjectId:actor},foreign={organizationId:org,tenantId:other,subjectId:foreignActor};
  const ids:string[]=[];let before:string;
  const inventory=async()=>JSON.stringify(await Promise.all([
    adminPrisma.subject.findMany({where:{organizationId:org},orderBy:{id:'asc'}}),
    adminPrisma.identityAccount.findMany({where:{organizationId:org},orderBy:{id:'asc'}}),
    adminPrisma.user.findMany({orderBy:{id:'asc'}}),adminPrisma.role.findMany({orderBy:{id:'asc'}}),
    adminPrisma.permission.findMany({orderBy:{id:'asc'}}),adminPrisma.userRole.findMany(),adminPrisma.rolePermission.findMany(),
    adminPrisma.accessPolicy.findMany({orderBy:{id:'asc'}}),adminPrisma.auditLog.findMany({orderBy:{id:'asc'}}),adminPrisma.legacyUserBridge.findMany(),
  ]));
  beforeAll(async()=>{
    await adminPrisma.organization.create({data:{id:org,name:'Token certification only'}});
    await adminPrisma.tenant.createMany({data:[{id:tenant,organizationId:org,name:'A'},{id:other,organizationId:org,name:'B'}]});
    await adminPrisma.subject.createMany({data:[{id:actor,organizationId:org,tenantId:tenant,type:'HUMAN',name:'Actor A'},
      {id:foreignActor,organizationId:org,tenantId:other,type:'HUMAN',name:'Actor B'}]});
    for(const [t,s] of [[tenant,actor],[other,foreignActor]]){
      const entitlement=await adminPrisma.entitlement.create({data:{organizationId:org,tenantId:t,key:'providers.manage',resource:'providers',action:'manage'}});
      await adminPrisma.assignment.create({data:{organizationId:org,tenantId:t,subjectId:s,entitlementId:entitlement.id,source:'DIRECT'}});
    }
    before=await inventory();
  });
  afterAll(async()=>{
    await adminPrisma.canonicalAdminAuditEvent.deleteMany({where:{organizationId:org}});
    await adminPrisma.providerConnectionTenantScope.deleteMany({where:{organizationId:org}});
    await adminPrisma.providerConnection.deleteMany({where:{organizationId:org}});
    await adminPrisma.assignment.deleteMany({where:{organizationId:org}});
    await adminPrisma.entitlement.deleteMany({where:{organizationId:org}});
    await adminPrisma.subject.deleteMany({where:{organizationId:org}});
    await adminPrisma.tenant.deleteMany({where:{organizationId:org}});await adminPrisma.organization.delete({where:{id:org}});
  });
  async function fixture(){
    const id=randomUUID();ids.push(id);
    const c:TokenContext={organizationId:org,tenantId:tenant,providerConnectionId:id,providerType:'MICROSOFT_ENTRA',credentialVersion:'N',authStrategy:'CLIENT_CREDENTIALS'};
    await adminPrisma.providerConnection.create({data:{id,organizationId:org,providerType:'MICROSOFT_ENTRA',externalScopeId:randomUUID(),name:'Controlled provider'}});
    await adminPrisma.providerConnectionTenantScope.create({data:{organizationId:org,tenantId:tenant,providerConnectionId:id,
      enabled:true,activeCredentialVersion:'N',credentialSecretRef:connectionSecretReference(c)}});
    const custody:SecretResolver={withSecret:vi.fn(async(_c,_r,consumer)=>{
      const lease=new SecretLease(new TextEncoder().encode('CONTROLLED_SECRET'));try{return await consumer(lease);}finally{lease.dispose();}})};
    const store=createScopedTokenStore(auth,custody);const network=vi.fn(async()=>({accessToken:'CONTROLLED_TOKEN',expiresIn:300}));
    const manager=store.manager(async(ctx,ref)=>store.resolver.withSecret({...ctx,operationId:randomUUID()},{key:ref},()=>network()),async()=>{});
    return {c,custody,store,manager,network};
  }
  it('app_user is nonprivileged and scope/audit RLS are forced',async()=>{
    const role=await withTenantDb(auth,tx=>tx.$queryRaw<Array<{current_user:string;rolsuper:boolean;rolbypassrls:boolean}>>`
      SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    expect(role[0]).toEqual({current_user:'app_user',rolsuper:false,rolbypassrls:false});
    const rows=await adminPrisma.$queryRaw<Array<{relrowsecurity:boolean;relforcerowsecurity:boolean}>>`
      SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('ProviderConnectionTenantScope','CanonicalAdminAuditEvent')`;
    expect(rows).toHaveLength(2);expect(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true);
  });
  for(const reason of ['organization','tenant','connection','provider','version','disabled','revoked'] as const)it(`${reason} DENY before custody/network`,async()=>{
    const f=await fixture();let c=f.c;
    if(reason==='tenant')c={...c,tenantId:other};
    if(reason==='organization')c={...c,organizationId:randomUUID()};
    if(reason==='connection')c={...c,providerConnectionId:randomUUID()};
    if(reason==='provider')c={...c,providerType:'GOOGLE_WORKSPACE'};
    if(reason==='version')c={...c,credentialVersion:'wrong'};
    if(reason==='disabled'||reason==='revoked')await adminPrisma.providerConnectionTenantScope.update({where:{organizationId_tenantId_providerConnectionId:{organizationId:org,tenantId:tenant,providerConnectionId:c.providerConnectionId}},
      data:reason==='disabled'?{enabled:false}:{credentialRevoked:true}});
    await expect(f.manager.getValidToken(c)).rejects.toThrow('PROVIDER_TOKEN_SCOPE_DENIED');
    expect(f.custody.withSecret).not.toHaveBeenCalled();expect(f.network).not.toHaveBeenCalled();
  });
  it('resolves only exact versioned custody reference and persists safe canonical audit',async()=>{
    const f=await fixture();await f.manager.getValidToken(f.c);
    expect(vi.mocked(f.custody.withSecret).mock.calls[0][1]).toEqual({key:versionedConnectionSecretReference(f.c)});
    const events=await withTenantDb(auth,tx=>tx.canonicalAdminAuditEvent.findMany({where:{operation:'PROVIDER.TOKEN.ACQUIRE.SUCCESS'}}));
    expect(events.some(e=>(e.metadata as {providerConnectionId:string}).providerConnectionId===f.c.providerConnectionId&&e.result==='SUCCESS')).toBe(true);
    expect(await withTenantDb(foreign,tx=>tx.canonicalAdminAuditEvent.findMany({where:{tenantId:tenant}}))).toEqual([]);
    expect(await withTenantDb(foreign,tx=>tx.providerConnectionTenantScope.findMany({where:{tenantId:tenant}}))).toEqual([]);
    await expect(withTenantDb(foreign,tx=>tx.providerConnectionTenantScope.updateMany({where:{tenantId:tenant},data:{credentialRevoked:true}}))).resolves.toMatchObject({count:0});
  });
  it('stages N+1, atomically rotates, invalidates N, then revokes',async()=>{
    const f=await fixture();await f.manager.getValidToken(f.c);await f.store.stageCandidate(f.c,'N1');
    await expect(f.manager.getValidToken({...f.c,credentialVersion:'N1'})).rejects.toThrow('PROVIDER_TOKEN_SCOPE_DENIED');
    await f.manager.rotateCredential(f.c,'N1');
    await expect(f.manager.getValidToken(f.c)).rejects.toThrow('PROVIDER_TOKEN_SCOPE_DENIED');
    const next={...f.c,credentialVersion:'N1'};await f.manager.getValidToken(next);await f.store.revoke(next,f.manager);
    await expect(f.manager.getValidToken(next)).rejects.toThrow('PROVIDER_TOKEN_SCOPE_DENIED');
    const events=await withTenantDb(auth,tx=>tx.canonicalAdminAuditEvent.findMany());
    expect(events.some(e=>e.operation==='PROVIDER.CREDENTIAL.ROTATE'&&e.result==='SUCCESS')).toBe(true);
    expect(events.some(e=>e.operation==='PROVIDER.CREDENTIAL.REVOKE'&&e.result==='SUCCESS')).toBe(true);
  });
  it('foreign actor cannot stage/activate/revoke this credential',async()=>{
    const f=await fixture(),store=createScopedTokenStore(foreign,f.custody);
    await expect(store.stageCandidate(f.c,'N1')).rejects.toThrow('PROVIDER_TOKEN_SCOPE_DENIED');
    await expect(store.activateCredential(f.c,{...f.c,credentialVersion:'N1'})).rejects.toThrow('PROVIDER_TOKEN_SCOPE_DENIED');
    await expect(store.revoke(f.c,f.manager)).rejects.toThrow('PROVIDER_TOKEN_SCOPE_DENIED');
    expect(f.custody.withSecret).not.toHaveBeenCalled();
  });
  it('runs scoped custody, OAuth acquisition and bounded Graph retry with controlled transport only',async()=>{
    const f=await fixture(),clientId=randomUUID(),directoryId=randomUUID();
    await adminPrisma.providerConnection.update({where:{id:f.c.providerConnectionId},data:{externalScopeId:directoryId}});
    await adminPrisma.providerConnectionTenantScope.update({where:{organizationId_tenantId_providerConnectionId:{organizationId:org,tenantId:tenant,providerConnectionId:f.c.providerConnectionId}},data:{configuration:{clientId}}});
    const ref=versionedConnectionSecretReference(f.c);process.env[ref]='CONTROLLED_SECRET';
    const output=vi.spyOn(console,'log').mockImplementation(()=>{});
    const transport=vi.fn().mockResolvedValueOnce(Response.json({access_token:'CONTROLLED_TOKEN',token_type:'Bearer',expires_in:300}))
      .mockResolvedValueOnce(new Response(null,{status:401}))
      .mockResolvedValueOnce(Response.json({access_token:'CONTROLLED_NEW_TOKEN',token_type:'Bearer',expires_in:300}))
      .mockResolvedValueOnce(Response.json({value:[]}));
    try {
      const {driver}=createVersionedEntraDriver(auth,{context:{...f.c,operationId:randomUUID()},type:'MICROSOFT_ENTRA',externalScopeId:directoryId,
        configuration:{clientId},attributeMapping:{},credentialSecretRef:connectionSecretReference(f.c)},'N',transport);
      await driver.testConnection();expect(transport).toHaveBeenCalledTimes(4);
      expect(JSON.stringify(output.mock.calls)).not.toContain('CONTROLLED_TOKEN');
    } finally {delete process.env[ref];output.mockRestore();}
  });
  it('persists FAILURE without provider error body or token and preserves identity/legacy inventory',async()=>{
    const f=await fixture();f.network.mockRejectedValueOnce(new Error('CONTROLLED_SECRET CONTROLLED_TOKEN Authorization: Bearer PRIVATE_REFRESH'));
    await expect(f.manager.acquire(f.c)).rejects.toThrow('PROVIDER_CREDENTIAL_INVALID');
    const events=await adminPrisma.canonicalAdminAuditEvent.findMany({where:{organizationId:org}});
    expect(events.some(e=>e.operation==='PROVIDER.TOKEN.ACQUIRE.FAILURE'&&e.result==='FAILURE')).toBe(true);
    expect(events.some(e=>e.operation==='PROVIDER.TOKEN.ACQUIRE.FAILURE'&&e.result==='DENIED')).toBe(true);
    for(const event of events)expect(Object.keys(event.metadata as object).every(k=>['providerConnectionId','providerType','credentialVersion','authStrategy','safeErrorCode','reason'].includes(k))).toBe(true);
    const scopes=await adminPrisma.providerConnectionTenantScope.findMany({where:{organizationId:org}});
    for(const secret of ['CONTROLLED_SECRET','CONTROLLED_TOKEN','CONTROLLED_NEW_TOKEN','PRIVATE_REFRESH','Authorization: Bearer']){
      expect(JSON.stringify(events)).not.toContain(secret);expect(JSON.stringify(scopes)).not.toContain(secret);
    }
    expect(await inventory()).toBe(before);
  });
});
