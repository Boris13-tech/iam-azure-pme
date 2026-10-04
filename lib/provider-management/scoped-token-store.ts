import {randomUUID,createHash} from 'node:crypto';
import type {Prisma,ProviderType} from '@prisma/client';
import {withTenantDb} from '../db/scoped-client';
import {authorize,type AuthContext} from '../auth/authorization-engine';
import type {SecretResolver} from '../provider-adapters';
import {connectionSecretReference,versionedConnectionSecretReference,ProviderManagementFailure} from './contracts';
import {ProviderTokenManager,type TokenContext,type TokenLease,type TokenManagerDependencies} from './token-manager';

const key = (c:TokenContext) => ({organizationId:c.organizationId,tenantId:c.tenantId,providerConnectionId:c.providerConnectionId});
const events = ['PROVIDER.TOKEN.ACQUIRE.SUCCESS','PROVIDER.TOKEN.ACQUIRE.FAILURE',
  'PROVIDER.TOKEN.CACHE.INVALIDATE','PROVIDER.CREDENTIAL.ROTATE','PROVIDER.CREDENTIAL.REVOKE'] as const;
const metadataKeys = ['providerConnectionId','providerType','credentialVersion','authStrategy','safeErrorCode','reason'];

export function createScopedTokenStore(auth:AuthContext, custody:SecretResolver) {
  auth=Object.freeze({...auth});
  const assertActor = (c:TokenContext) => {
    if(c.organizationId!==auth.organizationId||c.tenantId!==auth.tenantId)
      throw new ProviderManagementFailure('PROVIDER_TOKEN_SCOPE_DENIED');
  };
  const audit = async(tx:Prisma.TransactionClient,c:TokenContext,event:string,result:'SUCCESS'|'FAILURE'|'DENIED',metadata:Record<string,string>) => {
    if(!events.includes(event as typeof events[number]) || Object.keys(metadata).some(k=>!metadataKeys.includes(k)))
      throw new ProviderManagementFailure('PROVIDER_TOKEN_AUDIT_INVALID');
    if(metadata.providerConnectionId!==c.providerConnectionId||metadata.providerType!==c.providerType||
      metadata.credentialVersion!==c.credentialVersion||metadata.authStrategy!==c.authStrategy||
      (metadata.safeErrorCode!==undefined&&!['PROVIDER_CREDENTIAL_INVALID','PROVIDER_TOKEN_SCOPE_DENIED'].includes(metadata.safeErrorCode))||
      (metadata.reason!==undefined&&!['MANAGEMENT_DISABLED','CREDENTIAL_ROTATED','CREDENTIAL_REVOKED','PROVIDER_DELETED',
        'TENANT_SCOPE_REMOVED','CREDENTIAL_FAILURE_CONFIRMED','SECURITY_INVALIDATION'].includes(metadata.reason)))
      throw new ProviderManagementFailure('PROVIDER_TOKEN_AUDIT_INVALID');
    const control=event==='PROVIDER.CREDENTIAL.ROTATE'||event==='PROVIDER.CREDENTIAL.REVOKE';
    const changeId=control?`credential:${createHash('sha256').update(JSON.stringify([auth.subjectId,c.providerConnectionId,c.credentialVersion,event])).digest('hex')}`:randomUUID();
    await tx.canonicalAdminAuditEvent.createMany({data:[{organizationId:auth.organizationId,tenantId:auth.tenantId,
      actorSubjectId:auth.subjectId,operation:event,result,changeId,metadata}],skipDuplicates:control});
  };
  const authorizeScope:TokenManagerDependencies['authorize'] = async(c,purpose='ACTIVE') => {
    assertActor(c);
    const decision=await authorize(auth,{resource:'providers',action:'manage'});
    if(!decision.allowed)throw new ProviderManagementFailure('PROVIDER_TOKEN_SCOPE_DENIED');
    const resolved=await withTenantDb(auth,async tx=>{
      if(!await tx.organization.findUnique({where:{id:auth.organizationId},select:{id:true}}))return null;
      if(!await tx.tenant.findFirst({where:{organizationId:auth.organizationId,id:auth.tenantId},select:{id:true}}))return null;
      if(!await tx.subject.findFirst({where:{organizationId:auth.organizationId,tenantId:auth.tenantId,id:auth.subjectId,lifecycleState:'ACTIVE'},select:{id:true}}))return null;
      const scope=await tx.providerConnectionTenantScope.findUnique({where:{organizationId_tenantId_providerConnectionId:key(c)},include:{providerConnection:true}});
      if(!scope || scope.providerConnection.providerType!==c.providerType)return null;
      const expected=purpose==='ACTIVE'?scope.activeCredentialVersion:scope.candidateCredentialVersion;
      if(!scope.enabled||scope.credentialRevoked||!expected||expected!==c.credentialVersion||scope.credentialSecretRef!==connectionSecretReference(c)){
        await audit(tx,c,'PROVIDER.TOKEN.ACQUIRE.FAILURE','DENIED',{providerConnectionId:c.providerConnectionId,
          providerType:c.providerType,credentialVersion:c.credentialVersion,authStrategy:c.authStrategy,safeErrorCode:'PROVIDER_TOKEN_SCOPE_DENIED'});
        return null; // Commit denial evidence before throwing outside withTenantDb.
      }
      return {credentialSecretRef:scope.credentialSecretRef};
    });
    if(!resolved)throw new ProviderManagementFailure('PROVIDER_TOKEN_SCOPE_DENIED');
    return resolved;
  };
  const resolver:SecretResolver = {
    async withSecret(c,ref,consumer) {
      const context=c as unknown as TokenContext;
      if(ref.key!==connectionSecretReference(context))throw new ProviderManagementFailure('PROVIDER_SECRET_SCOPE_MISMATCH');
      // Only invoked by an acquisition after active/candidate scope validation.
      // Revalidate immediately before custody; candidate is permitted only for acquisition.
      assertActor(context);
      const pending=await withTenantDb(auth,tx=>tx.providerConnectionTenantScope.findUnique({
        where:{organizationId_tenantId_providerConnectionId:key(context)},select:{candidateCredentialVersion:true}}));
      await authorizeScope(context,pending?.candidateCredentialVersion===context.credentialVersion?'CANDIDATE':'ACTIVE');
      return custody.withSecret(c,{key:versionedConnectionSecretReference(context)},consumer);
    },
  };
  const writeAudit:TokenManagerDependencies['audit'] = async(c,event,metadata)=>{
    assertActor(c);
    await withTenantDb(auth,tx=>audit(tx,c,event,event.endsWith('.FAILURE')?'FAILURE':'SUCCESS',{...metadata}));
  };
  const activateCredential:TokenManagerDependencies['activateCredential'] = async(c,next)=>{
    await authorizeScope(c);await authorizeScope(next,'CANDIDATE');
    await withTenantDb(auth,async tx=>{
      const result=await tx.providerConnectionTenantScope.updateMany({where:{...key(c),enabled:true,credentialRevoked:false,
        credentialSecretRef:connectionSecretReference(c),providerConnection:{providerType:c.providerType as ProviderType},
        activeCredentialVersion:c.credentialVersion,candidateCredentialVersion:next.credentialVersion},
        data:{activeCredentialVersion:next.credentialVersion,candidateCredentialVersion:null,mappingVersion:{increment:1}}});
      if(result.count!==1)throw new ProviderManagementFailure('PROVIDER_CREDENTIAL_VERSION_CONFLICT');
      await audit(tx,next,'PROVIDER.CREDENTIAL.ROTATE','SUCCESS',{providerConnectionId:next.providerConnectionId,
        providerType:next.providerType,credentialVersion:next.credentialVersion,authStrategy:next.authStrategy});
    });
  };
  const stageCandidate = async(c:TokenContext,version:string)=>{
    if(!/^[A-Za-z0-9._-]{1,64}$/.test(version)||version===c.credentialVersion)throw new ProviderManagementFailure('PROVIDER_CREDENTIAL_VERSION_CONFLICT');
    await authorizeScope(c);
    return withTenantDb(auth,async tx=>{
      const result=await tx.providerConnectionTenantScope.updateMany({where:{...key(c),enabled:true,credentialRevoked:false,
        credentialSecretRef:connectionSecretReference(c),providerConnection:{providerType:c.providerType as ProviderType},
        activeCredentialVersion:c.credentialVersion,candidateCredentialVersion:null},data:{candidateCredentialVersion:version}});
      if(result.count!==1)throw new ProviderManagementFailure('PROVIDER_CREDENTIAL_VERSION_CONFLICT');
    });
  };
  const revoke = async(c:TokenContext,manager:ProviderTokenManager)=>{
    await authorizeScope(c);
    await withTenantDb(auth,async tx=>{
      const result=await tx.providerConnectionTenantScope.updateMany({where:{...key(c),activeCredentialVersion:c.credentialVersion,
        enabled:true,credentialSecretRef:connectionSecretReference(c),providerConnection:{providerType:c.providerType as ProviderType},
        credentialRevoked:false},data:{credentialRevoked:true,candidateCredentialVersion:null}});
      if(result.count!==1)throw new ProviderManagementFailure('PROVIDER_CREDENTIAL_VERSION_CONFLICT');
      await audit(tx,c,'PROVIDER.CREDENTIAL.REVOKE','SUCCESS',{providerConnectionId:c.providerConnectionId,
        providerType:c.providerType,credentialVersion:c.credentialVersion,authStrategy:c.authStrategy,reason:'CREDENTIAL_REVOKED'});
    });
    await manager.invalidate(c,'CREDENTIAL_REVOKED');
  };
  return {authorize:authorizeScope,audit:writeAudit,activateCredential,stageCandidate,revoke,resolver,
    manager(acquire:TokenManagerDependencies['acquire'],testCredential:(c:TokenContext,t:TokenLease)=>Promise<void>,now?:()=>number) {
      return new ProviderTokenManager({authorize:authorizeScope,audit:writeAudit,activateCredential,acquire,testCredential},now);
    }};
}
