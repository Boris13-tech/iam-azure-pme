import type {SecretResolver} from '../..';
import {ProviderManagementFailure} from '../../../provider-management/contracts';
import type {TokenContext} from '../../../provider-management/token-manager';

/** The manager must validate the DB scope before invoking this custody boundary. */
export function entraTokenAcquirer(resolver: SecretResolver,
  registration: (context: TokenContext) => Promise<{clientId:string;directoryId:string}>,
  transport: typeof fetch = fetch) {
  return async (context: TokenContext, reference: string): Promise<{accessToken:string;expiresIn:number}> => {
    if (context.providerType !== 'MICROSOFT_ENTRA' || context.authStrategy !== 'CLIENT_CREDENTIALS')
      throw new ProviderManagementFailure('PROVIDER_AUTH_STRATEGY_UNSUPPORTED');
    const config = await registration(context);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(config.clientId) || !uuid.test(config.directoryId))
      throw new ProviderManagementFailure('PROVIDER_CONFIGURATION_INCOMPLETE');
    try {
      return await resolver.withSecret({...context,operationId:'token-acquire'}, {key:reference},
        lease => lease.use(async bytes => {
          const response = await transport(`https://login.microsoftonline.com/${config.directoryId}/oauth2/v2.0/token`,{
            method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000),
            headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body:new URLSearchParams({client_id:config.clientId,client_secret:new TextDecoder().decode(bytes),
              grant_type:'client_credentials',scope:'https://graph.microsoft.com/.default'}),
          });
          if (!response.ok || !response.body) throw new Error('ACQUISITION_FAILED');
          const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
          try {
            while(true) {const next=await reader.read();if(next.done)break;size+=next.value.length;
              if(size>64_000)throw new Error('RESPONSE_TOO_LARGE');chunks.push(next.value);}
          } finally {await reader.cancel();}
          const data=new Uint8Array(size);let offset=0;
          for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
          const payload=JSON.parse(new TextDecoder().decode(data)) as Record<string,unknown>;
          if(typeof payload.access_token!=='string' || !payload.access_token || payload.token_type!=='Bearer' ||
            typeof payload.expires_in!=='number' || !Number.isFinite(payload.expires_in) || payload.expires_in<=0 ||
            payload.refresh_token!==undefined)throw new Error('INVALID_TOKEN_RESPONSE');
          return {accessToken:payload.access_token,expiresIn:payload.expires_in};
        }));
    } catch {throw new ProviderManagementFailure('PROVIDER_CREDENTIAL_INVALID');}
  };
}
