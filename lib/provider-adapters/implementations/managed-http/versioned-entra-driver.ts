import type {AuthContext} from '../../../auth/authorization-engine';
import {EnvironmentSecretResolver} from '../../infrastructure/environment-secret-resolver';
import {createScopedTokenStore} from '../../../provider-management/scoped-token-store';
import {entraTokenAcquirer} from './entra-token-acquirer';
import {configurationSchema,connectionSecretReference,ProviderManagementFailure} from '../../../provider-management/contracts';
import {withTenantDb} from '../../../db/scoped-client';
import type {TokenContext} from '../../../provider-management/token-manager';
import {createManagedHttpDriver} from './driver';

/** Explicit opt-in management factory; never changes existing OIDC login routing. */
export function createVersionedEntraDriver(auth:AuthContext,
  input:Parameters<typeof createManagedHttpDriver>[0],credentialVersion:string,
  transport:typeof fetch=fetch) {
  const config=configurationSchema.parse(input.configuration);
  if(input.type!=='MICROSOFT_ENTRA'||!config.clientId)throw new ProviderManagementFailure('PROVIDER_CONFIGURATION_INCOMPLETE');
  if(input.credentialSecretRef!==connectionSecretReference(input.context))throw new ProviderManagementFailure('PROVIDER_SECRET_SCOPE_MISMATCH');
  const store=createScopedTokenStore(auth,new EnvironmentSecretResolver());
  const tokenContext:TokenContext={...input.context,providerType:'MICROSOFT_ENTRA',credentialVersion,authStrategy:'CLIENT_CREDENTIALS'};
  const manager=store.manager(entraTokenAcquirer(store.resolver,async()=>withTenantDb(auth,async tx=>{
    const scope=await tx.providerConnectionTenantScope.findUnique({where:{organizationId_tenantId_providerConnectionId:{
      organizationId:auth.organizationId,tenantId:auth.tenantId,providerConnectionId:input.context.providerConnectionId}},include:{providerConnection:true}});
    const stored=configurationSchema.parse(scope?.configuration);
    if(!scope||scope.providerConnection.providerType!=='MICROSOFT_ENTRA'||stored.clientId!==config.clientId||scope.providerConnection.externalScopeId!==input.externalScopeId)
      throw new ProviderManagementFailure('PROVIDER_TOKEN_SCOPE_DENIED');
    return {clientId:stored.clientId!,directoryId:scope.providerConnection.externalScopeId};
  }),transport),
    async(_c,token)=>{
      const response=await transport('https://graph.microsoft.com/v1.0/users?$select=id&$top=1',{
        headers:{Authorization:`Bearer ${token.accessToken}`},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)});
      await response.body?.cancel();
      if(response.status!==200)throw new ProviderManagementFailure('PROVIDER_CREDENTIAL_INVALID');
    });
  return {driver:createManagedHttpDriver({...input,tokenManager:manager,tokenContext,tokenTransport:transport}),manager,store};
}
