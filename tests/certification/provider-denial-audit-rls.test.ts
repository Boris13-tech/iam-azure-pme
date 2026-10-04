import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adminPrisma } from "../helpers/admin-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { runProviderOperation } from "../../lib/provider-management/service";
import { canonicalAdminErrorResponse } from "../../lib/admin/http";

// Run separately from legacy-mutating suites so full legacy snapshots are stable.
describe("Provider pre-network denial evidence — real PostgreSQL/runtime RLS", () => {
  const org=randomUUID(),tenant=randomUUID(),foreignTenant=randomUUID(),actor=randomUUID(),foreignActor=randomUUID();
  const auth={organizationId:org,tenantId:tenant,subjectId:actor};
  const foreign={organizationId:org,tenantId:foreignTenant,subjectId:foreignActor};
  const connections:string[]=[];
  const healthy=()=>({testConnection:async()=>{},async *discover(){}});
  const inventory=async()=>JSON.stringify(await Promise.all([
    adminPrisma.subject.findMany({where:{organizationId:org},orderBy:{id:'asc'}}),
    adminPrisma.identityAccount.findMany({where:{organizationId:org},orderBy:{id:'asc'}}),
    adminPrisma.user.findMany({orderBy:{id:'asc'}}),adminPrisma.role.findMany({orderBy:{id:'asc'}}),
    adminPrisma.permission.findMany({orderBy:{id:'asc'}}),adminPrisma.userRole.findMany(),adminPrisma.rolePermission.findMany(),
    adminPrisma.accessPolicy.findMany({orderBy:{id:'asc'}}),adminPrisma.auditLog.findMany({orderBy:{id:'asc'}}),
    adminPrisma.legacyUserBridge.findMany({orderBy:{id:'asc'}}),
  ]));
  beforeAll(async()=>{
    await adminPrisma.organization.create({data:{id:org,name:'Denial audit isolated fixtures'}});
    await adminPrisma.tenant.createMany({data:[{id:tenant,organizationId:org,name:'A'},{id:foreignTenant,organizationId:org,name:'B'}]});
    await adminPrisma.subject.createMany({data:[{id:actor,organizationId:org,tenantId:tenant,name:'Certification A',type:'HUMAN'},
      {id:foreignActor,organizationId:org,tenantId:foreignTenant,name:'Certification B',type:'HUMAN'}]});
  });
  afterAll(async()=>{
    await adminPrisma.canonicalAdminAuditEvent.deleteMany({where:{organizationId:org}});
    await adminPrisma.providerSyncRun.deleteMany({where:{organizationId:org}});
    await adminPrisma.providerConnectionTenantScope.deleteMany({where:{organizationId:org}});
    await adminPrisma.providerConnection.deleteMany({where:{organizationId:org}});
    await adminPrisma.subject.deleteMany({where:{organizationId:org}});
    await adminPrisma.tenant.deleteMany({where:{organizationId:org}});
    await adminPrisma.organization.delete({where:{id:org}});
  });
  async function connection(type:'MICROSOFT_ENTRA'|'AWS'|'OIDC_GENERIC',enabled=true){
    const id=randomUUID();connections.push(id);
    await adminPrisma.providerConnection.create({data:{id,organizationId:org,providerType:type,externalScopeId:randomUUID(),name:'Denial fixture'}});
    await adminPrisma.providerConnectionTenantScope.create({data:{organizationId:org,tenantId:tenant,providerConnectionId:id,enabled,
      configuration:{clientId:randomUUID()},credentialSecretRef:'LUXIA_PROVIDER_PRIVATE_FIXTURE'}});
    return id;
  }
  const cases=[
    ['PROVIDER_DISABLED','MICROSOFT_ENTRA','CONNECTION_TEST',409],
    ['PROVIDER_OPERATION_UNSUPPORTED','AWS','CONNECTION_TEST',422],
    ['DIRECTORY_DISCOVERY_UNSUPPORTED','OIDC_GENERIC','SYNC_DRY_RUN',422],
    ['PROVIDER_OPERATION_IN_PROGRESS','MICROSOFT_ENTRA','CONNECTION_TEST',409],
    ['PROVIDER_OPERATION_ID_CONFLICT','MICROSOFT_ENTRA','SYNC_DRY_RUN',409],
  ] as const;
  for(const [reason,type,operation,status] of cases)it(`${reason} commits exactly one DENIED, no driver/run/identity/legacy change`,async()=>{
    const id=await connection(type,reason!=='PROVIDER_DISABLED');const changeId=randomUUID();
    if(reason==='PROVIDER_OPERATION_IN_PROGRESS')await adminPrisma.providerSyncRun.create({data:{organizationId:org,tenantId:tenant,
      providerConnectionId:id,operationId:randomUUID(),operation:'SYNC_DRY_RUN',mode:'DRY_RUN',status:'RUNNING'}});
    if(reason==='PROVIDER_OPERATION_ID_CONFLICT')await runProviderOperation(auth,id,'CONNECTION_TEST',changeId,healthy);
    const before=await inventory();
    const runsBefore=await adminPrisma.providerSyncRun.findMany({where:{providerConnectionId:id},orderBy:{id:'asc'}});
    const factory=vi.fn(healthy);
    const errors=await Promise.all([1,2].map(async()=>{
      try {await runProviderOperation(auth,id,operation,changeId,factory);throw new Error('unexpected acceptance');}catch(error){return error;}
    }));
    for(const error of errors){expect(error).toMatchObject({code:reason,httpStatus:status});
      const response=canonicalAdminErrorResponse(error);expect(response.status).toBe(status);expect(await response.json()).toEqual({error:reason});}
    expect(factory).not.toHaveBeenCalled();
    expect(await adminPrisma.providerSyncRun.findMany({where:{providerConnectionId:id},orderBy:{id:'asc'}})).toEqual(runsBefore);
    const events=await withTenantDb(auth,tx=>tx.canonicalAdminAuditEvent.findMany({where:{changeId}}));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({operation:`PROVIDER.${operation}.DENIED`,result:'DENIED',actorSubjectId:actor,organizationId:org,tenantId:tenant,
      metadata:{providerConnectionId:id,reasonCode:reason,requestedOperation:operation}});
    expect(Object.keys(events[0].metadata as object).sort()).toEqual(['providerConnectionId','reasonCode','requestedOperation']);
    expect(JSON.stringify(events)).not.toContain('LUXIA_PROVIDER_PRIVATE_FIXTURE');
    expect(await withTenantDb(foreign,tx=>tx.canonicalAdminAuditEvent.findMany({where:{changeId}}))).toEqual([]);
    expect(await inventory()).toBe(before);
    if(reason==='PROVIDER_OPERATION_ID_CONFLICT'){
      const replay=await runProviderOperation(auth,id,'CONNECTION_TEST',changeId,factory);
      expect(replay?.id).toBe(runsBefore[0].id);expect(factory).not.toHaveBeenCalled();
      expect(await adminPrisma.canonicalAdminAuditEvent.count({where:{organizationId:org,tenantId:tenant,changeId,result:'DENIED'}})).toBe(1);
    }
  });
  it('foreign scope remains 404 without revealing or adding tenant audit',async()=>{
    const id=connections[0],changeId=randomUUID();const factory=vi.fn(healthy);
    await expect(runProviderOperation(foreign,id,'CONNECTION_TEST',changeId,factory)).rejects.toMatchObject({code:'PROVIDER_NOT_IN_TENANT_SCOPE',httpStatus:404});
    expect(factory).not.toHaveBeenCalled();
    expect(await adminPrisma.canonicalAdminAuditEvent.count({where:{organizationId:org,changeId}})).toBe(0);
  });
  it('runtime is app_user NOSUPERUSER NOBYPASSRLS',async()=>{
    const role=await withTenantDb(auth,tx=>tx.$queryRaw<Array<{current_user:string;rolsuper:boolean;rolbypassrls:boolean}>>`
      SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    expect(role[0]).toEqual({current_user:'app_user',rolsuper:false,rolbypassrls:false});
  });
  it('audit persistence failure remains fail-closed without a driver or RUNNING run',async()=>{
    const id=await connection('MICROSOFT_ENTRA',false);const changeId=randomUUID();const factory=vi.fn(healthy);
    await expect(runProviderOperation({...auth,subjectId:randomUUID()},id,'CONNECTION_TEST',changeId,factory)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(await adminPrisma.providerSyncRun.count({where:{providerConnectionId:id}})).toBe(0);
    expect(await adminPrisma.canonicalAdminAuditEvent.count({where:{organizationId:org,changeId}})).toBe(0);
  });
  it('historical START key remains immutable and conflict has one deterministic denial',async()=>{
    const id=await connection('MICROSOFT_ENTRA');const changeId=randomUUID();
    const run=await adminPrisma.providerSyncRun.create({data:{organizationId:org,tenantId:tenant,providerConnectionId:id,
      operationId:changeId,operation:'CONNECTION_TEST',mode:'DRY_RUN',status:'DRY_RUN_COMPLETE'}});
    const historical=await adminPrisma.canonicalAdminAuditEvent.create({data:{organizationId:org,tenantId:tenant,actorSubjectId:actor,
      operation:'PROVIDER.CONNECTION_TEST.START',result:'SUCCESS',changeId,metadata:{providerConnectionId:id}}});
    const factory=vi.fn(healthy);
    for(let n=0;n<2;n++)await expect(runProviderOperation(auth,id,'SYNC_DRY_RUN',changeId,factory)).rejects.toMatchObject({code:'PROVIDER_OPERATION_ID_CONFLICT'});
    const events=await adminPrisma.canonicalAdminAuditEvent.findMany({where:{organizationId:org,tenantId:tenant,operation:'PROVIDER.SYNC_DRY_RUN.DENIED',metadata:{path:['providerConnectionId'],equals:id}}});
    expect(events).toHaveLength(1);expect(events[0].changeId).toMatch(/^denied:[a-f0-9]{64}$/);
    expect(await adminPrisma.canonicalAdminAuditEvent.findUnique({where:{id:historical.id}})).toEqual(historical);
    expect((await runProviderOperation(auth,id,'CONNECTION_TEST',changeId,factory))?.id).toBe(run.id);expect(factory).not.toHaveBeenCalled();
  });
});
